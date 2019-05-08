const Y = require('yjs')
const syncProtocol = require('y-protocols/dist/sync.js')
const awarenessProtocol = require('y-protocols/dist/awareness.js')

const encoding = require('lib0/dist/encoding.js')
const decoding = require('lib0/dist/decoding.js')
const mutex = require('lib0/dist/mutex.js')
const map = require('lib0/dist/map.js')

const wsReadyStateConnecting = 0
const wsReadyStateOpen = 1
const wsReadyStateClosing = 2 // eslint-disable-line
const wsReadyStateClosed = 3 // eslint-disable-line

// disable gc when using snapshots!
const gcEnabled = process.env.GC !== 'false' && process.env.GC !== '0'
const persistenceDir = process.env.YPERSISTENCE
/**
 * @type {{bindState: function(string,WSSharedDoc):void, writeState:function(string,WSSharedDoc):Promise}|null}
 */
let persistence = null
if (typeof persistenceDir === 'string') {
  // @ts-ignore
  const LevelDbPersistence = require('y-leveldb').LevelDbPersistence
  persistence = new LevelDbPersistence(persistenceDir)
}

/**
 * @type {Map<number,WSSharedDoc>}
 */
const docs = new Map()

const messageSync = 0
const messageAwareness = 1
// const messageAuth = 2

/**
 * @param {Uint8Array} update
 * @param {any} origin
 * @param {WSSharedDoc} doc
 */
const updateHandler = (update, origin, doc) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync)
  syncProtocol.writeUpdate(encoder, update)
  const message = encoding.toUint8Array(encoder)
  doc.conns.forEach((_, conn) => send(doc, conn, message))
}

class WSSharedDoc extends Y.Doc {
  /**
   * @param {string} name
   */
  constructor (name) {
    super({ gc: gcEnabled })
    this.name = name
    this.mux = mutex.createMutex()
    /**
     * Maps from conn to set of controlled user ids. Delete all user ids from awareness when this conn is closed
     * @type {Map<Object, Set<number>>}
     */
    this.conns = new Map()
    /**
     * @type {Map<number,Object>}
     */
    this.awareness = new Map()
    /**
     * @type {Map<number,number>}
     */
    this.awarenessClock = new Map()
    this.on('update', updateHandler)
  }
}

/**
 * @param {any} conn
 * @param {WSSharedDoc} doc
 * @param {Uint8Array} message
 */
const messageListener = (conn, doc, message) => {
  const encoder = encoding.createEncoder()
  const decoder = decoding.createDecoder(message)
  const messageType = decoding.readVarUint(decoder)
  switch (messageType) {
    case messageSync:
      encoding.writeVarUint(encoder, messageSync)
      syncProtocol.readSyncMessage(decoder, encoder, doc, null)
      if (encoding.length(encoder) > 1) {
        send(doc, conn, encoding.toUint8Array(encoder))
      }
      break
    case messageAwareness: {
      encoding.writeVarUint(encoder, messageAwareness)
      const updates = awarenessProtocol.forwardAwarenessMessage(decoder, encoder)
      updates.forEach(update => {
        doc.awareness.set(update.clientID, update.state)
        doc.awarenessClock.set(update.clientID, update.clock)
        // @ts-ignore we received an update => so conn exists
        doc.conns.get(conn).add(update.clientID)
      })
      const buff = encoding.toUint8Array(encoder)
      doc.conns.forEach((_, c) => {
        send(doc, c, buff)
      })
      break
    }
  }
}

/**
 * @param {WSSharedDoc} doc
 * @param {any} conn
 */
const closeConn = (doc, conn) => {
  if (doc.conns.has(conn)) {
    /**
     * @type {Set<number>}
     */
    // @ts-ignore
    const controlledIds = doc.conns.get(conn)
    doc.conns.delete(conn)
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageAwareness)
    awarenessProtocol.writeUsersStateChange(encoder, Array.from(controlledIds).map(clientID => {
      const clock = (doc.awarenessClock.get(clientID) || 0) + 1
      doc.awareness.delete(clientID)
      doc.awarenessClock.delete(clientID)
      return { clientID, state: null, clock }
    }))
    const buf = encoding.toUint8Array(encoder)
    doc.conns.forEach((_, conn) => {
      send(doc, conn, buf)
    })
    if (doc.conns.size === 0 && persistence !== null) {
      // if persisted, we store state and destroy ydocument
      persistence.writeState(doc.name, doc).then(() => {
        doc.destroy()
      })
      doc.conns.delete(doc.name)
    }
  }
  conn.close()
}

/**
 * @param {WSSharedDoc} doc
 * @param {any} conn
 * @param {Uint8Array} m
 */
const send = (doc, conn, m) => {
  if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen) {
    closeConn(doc, conn)
  }
  try {
    conn.send(m, /** @param {any} err */ err => { err != null && closeConn(doc, conn) })
  } catch (e) {
    closeConn(doc, conn)
  }
}

const pingTimeout = 30000

/**
 * @param {any} conn
 * @param {any} req
 */
exports.setupWSConnection = (conn, req) => {
  conn.binaryType = 'arraybuffer'
  // get doc, create if it does not exist yet
  const docName = req.url.slice(1)
  const doc = map.setIfUndefined(docs, docName, () => {
    const doc = new WSSharedDoc(docName)
    if (persistence !== null) {
      persistence.bindState(docName, doc)
    }
    docs.set(docName, doc)
    return doc
  })
  doc.conns.set(conn, new Set())
  // listen and reply to events
  conn.on('message', /** @param {ArrayBuffer} message */ message => messageListener(conn, doc, new Uint8Array(message)))
  conn.on('close', () => {
    closeConn(doc, conn)
  })
  // Check if connection is still alive
  let pongReceived = true
  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      if (doc.conns.has(conn)) {
        closeConn(doc, conn)
      }
      clearInterval(pingInterval)
    } else if (doc.conns.has(conn)) {
      pongReceived = false
      try {
        conn.ping()
      } catch (e) {
        closeConn(doc, conn)
      }
    }
  }, pingTimeout)
  conn.on('pong', () => {
    pongReceived = true
  })
  // send sync step 1
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync)
  syncProtocol.writeSyncStep1(encoder, doc)
  send(doc, conn, encoding.toUint8Array(encoder))
  if (doc.awareness.size > 0) {
    const encoder = encoding.createEncoder()
    /**
     * @type {Array<Object>}
     */
    const userStates = []
    doc.awareness.forEach((state, clientID) => {
      userStates.push({ state, clientID, clock: (doc.awarenessClock.get(clientID) || 0) })
    })
    encoding.writeVarUint(encoder, messageAwareness)
    awarenessProtocol.writeUsersStateChange(encoder, userStates)
    send(doc, conn, encoding.toUint8Array(encoder))
  }
}