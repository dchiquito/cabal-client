const collect = require('collect-stream')
const timestamp = require('monotonic-timestamp')
const { stableSort, merge } = require('./util')

class ChannelDetailsBase {
  constructor (channelName) {
    this.name = channelName

    this.isPrivate = false
    this.members = new Set()
    this.mentions = []
    /* archived channels are not visible in channel listings */
    this.archived = false
    this.virtualMessages = []
    this.newMessageCount = 0
    this.datesSeen = new Set()
    /* TODO:
    use cursor to remember scrollback state and fetch
    from leveldb.
    maybe store a negative offset to look up? */
    this.lastRead = 0 /* timestamp in epoch time */
    this.joined = false
    this.focused = false
    this.topic = ''
  }

  toString () {
    return this.name
  }

  archive () {
    this.archived = true
  }

  unarchive () {
    this.archived = false
  }

  addMember (key) {
    this.members.add(key)
  }

  removeMember (key) {
    this.members.delete(key)
  }

  getMembers () {
    return Array.from(this.members)
  }

  addMention (mention) {
    if (!this.focused) {
      this.mentions.push(mention)
    }
  }

  getMentions () {
    return this.mentions.slice() // return copy
  }

  handleMessage (message) {
    if (!this.focused) {
      // ++var is an optimization:
      // var++ creates a temporary variable while ++var doesn't
      ++this.newMessageCount
    }
  }

  getNewMessageCount () {
    return this.newMessageCount
  }

  markAsRead () {
    this.lastRead = Date.now()
    this.newMessageCount = 0
    this.mentions = []
  }

  focus () {
    this.focused = true
  }

  unfocus () {
    this.focused = false
  }

  clearVirtualMessages () {
    this.virtualMessages = []
  }

  getVirtualMessages (opts) {
    const limit = opts.limit
    const newerThan = parseFloat(opts.gt || 0)
    const olderThan = parseFloat(opts.lt || Infinity)
    var filtered = this.virtualMessages.filter((m) => {
      return (parseFloat(m.value.timestamp) > newerThan && parseFloat(m.value.timestamp) < olderThan)
    })
    return stableSort(filtered, v => parseFloat(v.value.timestamp)).slice(-limit)
  }

  interleaveVirtualMessages (messages, opts) {
    const virtualMessages = this.getVirtualMessages(opts)
    var cmp = (a, b) => {
      // sort by timestamp
      const diff = parseFloat(a.value.timestamp) - parseFloat(b.value.timestamp)
      // if timestamp was the same, and messages are by same author, sort by seqno
      if (diff === 0 &&
        a.key && b.key && a.key === b.key &&
        a.hasOwnProperty('seq') && b.hasOwnProperty('seq')) {
        return a.seq - b.seq
      }
      return diff
    }
    return virtualMessages.concat(messages).sort(cmp).slice(-opts.limit)
  }

  /*
  addVirtualMessage({ timestamp: Date.now(), type: "status", text: "" }})
  */
  addVirtualMessage (msg) {
    /*
    msg will be on the format of
    {timestamp, type, text}
    but we convert it to the format that cabal expects messages to conform to
     msg = {
       key: ''
       value: {
         timestamp: ''
         type: ''
         content: {
           text: ''
         }
       }
     }
     */
    if (!msg.value) {
      msg = {
        key: this.name,
        value: {
          timestamp: msg.timestamp || timestamp(),
          type: msg.type || 'status',
          content: {
            text: msg.text
          }
        }
      }
    }
    this.virtualMessages.push(msg)
  }

  // returns false if we were already in the channel, otherwise true
  join () {
    var joined = this.joined
    this.joined = true
    return joined
  }

  // returns true if we were previously in the channel, otherwise false
  leave () {
    var joined = this.joined
    this.joined = false
    return joined
  }
}

class ChannelDetails extends ChannelDetailsBase {
  constructor (cabal, channelName) {
    super(channelName)
    this.messages = cabal.messages
  }

  getPage (opts) {
    opts = opts || {}
    const OGopts = Object.assign({}, opts)
    return new Promise((resolve, reject) => {
      const rs = this.messages.read(this.name, opts)
      collect(rs, (err, msgs) => {
        if (err) {
          return reject(err)
        }
        const reversed = []
        for (let i = msgs.length - 1; i >= 0; --i) {
          const msg = msgs[i]
          reversed.push(msg)
          const msgTime = msg.value.timestamp
          const dayTimestamp = msgTime - (msgTime % (24 * 60 * 60 * 1000))
          if (!this.datesSeen.has(dayTimestamp)) {
            this.datesSeen.add(dayTimestamp)
            this.addVirtualMessage({
              key: this.name,
              value: {
                timestamp: dayTimestamp,
                type: 'status/date-changed'
              }
            })
          }
        }
        resolve(this.interleaveVirtualMessages(reversed, OGopts))
      })
    })
  }
}

class VirtualChannelDetails extends ChannelDetailsBase {
  constructor (channelName) {
    super(channelName)
    this.joined = true
  }

  getPage (opts) {
    return Promise.resolve(this.interleaveVirtualMessages([], opts))
  }
}

class PMChannelDetails extends ChannelDetails {
  constructor (cabal, pubkey) {
    super(cabal, pubkey)
    // change cabal api we read from to be private messages (not messages api)
    this.messages = cabal.privateMessages
    this.recipient = pubkey
    this.isPrivate = true
    this.topic = "private message with " + pubkey
    this.joined = true
    this.members.add(this.recipientKey) // makes sure # members > 0 :)
  }

  toString () {
    return `PM-${this.recipient.slice(0,8)}`
  }
}

module.exports = { ChannelDetails, VirtualChannelDetails, PMChannelDetails }
