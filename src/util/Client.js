const nocket = require('../../../nocket/nocket');
const Discord = require('./Discord');

/**
 * All the opcodes that go through the gateway. Some can
 * only be sent and some can only be received.
 * @const
 * @type {Object}
 */



/** 
 * Extends the Discord class but will also create and maintain
 * a connection to the gateway, allowing some extra functions.
 * @author Nicholas J D Dean <nickdean.io>
 * @extends Discord
 * @prop {boolean} isBot - Is the token associated with this client
 * a bot or not. This affects the authorization headers and gateway
 * endpoints.
 * @prop {number} shardCount - The number of shards received when requesting
 * the gateway URL.
 * @prop {Object} socket - The websocket used to communicate with the gateway.
 * @prop {Object} me - The object containing the current user.
 * This will be set when the 'ready' dispatch is received.
 * @prop {Object} heartbeatIntervalObj - The object returned by the
 * setInterval() call for the hearbeat function. Needed to stop the 
 * heartbeat function being called after the connection is closed.
 * @prop {number} lastSequenceNum - The last sequence number received
 * from the gateway. Needed for resuming a session and heartbeats.
 * @prop {boolean} hearbeatAcknowledged - Whether or not the last
 * heartbeat was acknowledged by the server.
 * @prop {string} sessionID - The session ID received from the server
 * that can be used to resume the session when reconnecting.
 * @prop {boolean} resuming - Is the client currently attempting to
 * resume the connection. A few functions will behave differently if
 * they're connecting for the first time or attempting a resume.
 * @prop {Object} dispatchCallbacks - The object that stores all callbacks
 * resgistered to certain dispatch events. The keys are the event names and
 * the values are the callbacks.
 * @prop {string} commandChar - The character that needs to be the first
 * character in a message for it to be considered a command.
 * @prop {Object} commandCallbacks - The object that stores all callbacks
 * registered to different command words. The keys are the command words
 * and the values are the callbacks.
 * @prop {Object} guilds - All guilds that the bot is in. These need to be
 * stored because when requesting a guild from the API, you don't get all the
 * information that you do in a GUILD_CREATE event.
 * @prop {Object} GatewayOpcodes - All the opcodes that go through
 * the gateway and their meanings.
 */
class Client extends Discord {
    /** Create a connection to the gateway. 
     * @param {string} token - The secret_key to use when 
     * interfacing with the API.
     * @param {boolean} isBot - Is the secret key associated with a bot
     * account or not.
    */
    constructor(token, intents, isBot = true) {
        super(token);
        this.GatewayOpcodes = {
            0: 'Dispatch',
            1: 'Heartbeat',
            2: 'Identify',
            3: 'Status Update',
            4: 'Voice State Update',
            5: 'Voice Server Ping',
            6: 'Resume',
            7: 'Reconnect',
            8: 'Request Guild Members',
            9: 'Invalid Session',
            10: 'Hello',
            11: 'Heartbeat ACK'
        }

        this.intents = intents;
        this.isBot = isBot
        this.shardCount = null;
        this.socket = null;
        this.me = null;
        this.heartbeatIntervalObj = null;
        this.lastSequenceNum = null;
        this.heartbeatAcknowledged = true;
        this.sessionID = null;
        this.resuming = false;
        this.dispatchCallbacks = {};
        this.commandChar = '!';
        this.commandCallbacks = {};
        this.guilds = {};
        this._gatewayConnect();
    }
    
    
    /**
     * Check if the previous heartbeat was acknowledged. If it wasn't,
     * then attempt to reconnect. Else send another heartbeat.
     * 
     * This should be called according to the heartbeat_interval received
     * in the 'hello' message from the server.
     * @private
     */
    _heartbeat() {
        if (this.heartbeatAcknowledged === false) {
            this.loga.warn('No heartbeat ACK. Reconnecting');
            
            this.reconnect();
        } else {
            //send a heartbeat
            this.heartbeatAcknowledged = false;
            this._sendOpcode(1, this.lastSequenceNum)
        }
    }
    
    
    /**
     * Respond to data received through the websocket connected
     * to the gateway.
     * @private
     * @param {Object} obj - A gateway object received from the server. 
     */
    _handleGatewayObject(obj) {
        const opName = this.GatewayOpcodes[obj.op];
        
        //Heartbeats clutter logs, so give them a higher level
        //allowing them to be specifically excluded
        const logLevel = opName === 'Heartbeat ACK' ? 6 : 5;
        this.loga.log(`Received OP ${obj.op}: ${opName}`, logLevel);
        
        switch (opName) {
            case 'Dispatch':
                this.lastSequenceNum = obj.s;
                this._handleDispatch(obj.t, obj.d);
                break;
            
            case 'Heartbeat':
                //if the server sends a heartbeat, send one back
                this._heartbeat(this.lastSequenceNum);
                break;
            
            case 'Reconnect':
                this.reconnect();
                break;
            
            case 'Invalid Session':
                //I think that by this point the socket
                //has already been closed by the server,
                //so socket.end won't exist, maybe    
                if (this.socket) {
                    this.socket.end();
                }
                break;
            
            case 'Hello':
                this._handleHello(obj.d.heartbeat_interval);
                break;
            
            case 'Heartbeat ACK':
                this.heartbeatAcknowledged = true;
                break;
        }   
    }
    
    
    /**
     * Handle an opcode 0 received through the gateway,
     * @private
     * @param {string} dispatchName - The dispatch event name.
     * @param {*} data - The contents of the 'd' attribute of the gateway object.
     */
    _handleDispatch(dispatchName, data) {
        this.loga.log(`Dispatch event: ${dispatchName}`, 4);
        
        this._emitEvent(dispatchName, data);
        
        switch(dispatchName) {
            case 'READY':
                this.sessionID = data.session_id;
                this.me = data.user;
                break;

            case 'GUILD_CREATE':
                this.guilds[data.id] = data;
                break;
            
            case 'MESSAGE_CREATE':
                const msg = data.content;
                //check for a command
                if (msg[0] === this.commandChar) {
                    //remove the commandChar
                    const command = msg.substr(1, msg.length - 1);
                    
                    //split the command by spaces to take the first word
                    const commandWord = command.split(' ')[0].toLowerCase();
                    const firstSpace = command.indexOf(' ');
                    const len = command.length - firstSpace;
                    
                    //add 1 to remove the space after the command word
                    const restOfCommand = command.substr(firstSpace+1, len);
                    
                    //callback with all the rest of the command
                    const callback = this.commandCallbacks[commandWord];
                    if (callback) {
                        this.loga.log(`Command received: ${commandWord}`);
                        callback(data, restOfCommand);
                    }
                }
                break;
            
            case 'RESUMED':
                this.resuming = false;
                break;
        }
    }
    
    
    /**
     * To be run when the hello gateway object is received.
     * Either sends an identify opcode back, or attempts to
     * resume the previous session, depending on this.resuming. 
     * @private
     * @param {int} interval - The heartbeat interval received in the hello payload.
     */
    _handleHello(interval) {        
        //create a function to be run every interval
        //and store it in an object so that it can
        //be stopped in the future
        this.heartbeatIntervalObj = setInterval(() => { 
            this._heartbeat();
        }, interval);
        
        this.loga.log(`Heartbeat set to ${interval}ms`);
        
        if (this.resuming === false) {
            //send OP 2: IDENTIFY
            this._sendOpcode(2, {
                token: this.token,
                intents: this.intents,
                properties: {},
                compress: false,
                large_threshold: 100,
                presence: { //status object
                    since: null,
                    status: "online",
                    game: null,
                    afk: false
                }
            });
        } else {
            //send OP 6: RESUME
            this._sendOpcode(6, {
                token: this.token,
                session_id: this.sessionID,
                seq: this.lastSequenceNum
            });
        }
    }
    
    
    
    /**
     * Send an opcode to the gateway.
     * @private
     * @param {int} op - Opcode for the payload.
     * @param {Object} d - Event data.
     * @param {int} s - Sequence number, used for resuming sessions and heartbeats.
     * @param {string} t - The event name for the payload.
     */
    _sendOpcode(op, d, s = null, t = null) {
        //Place heartbeats on a higher log level.
        const logLevel = this.GatewayOpcodes[op] === 'Heartbeat' ? 6 : 5;
        this.loga.log(`Sending OP ${op}: ${this.GatewayOpcodes[op]}`, logLevel);
        
        this.socket.write(JSON.stringify({op, d, s, t}));
    }
    
    
    /**
     * Run the callback associated with a specific event, if one has
     * been registered using the onEvent function. Sends all data that was
     * received in the dispatch with the event.
     * 
     * For example, the 'MESSAGE_CREATE' event is send with the full
     * message object that was created. This will be passed as a parameter
     * to the callback.
     * @private
     * @param {string} eventName - The event name. 
     * @param {object} eventData - The data associated with the event.
     */
    _emitEvent(eventName, eventData) {
        if (this.dispatchCallbacks[eventName]) {
            this.dispatchCallbacks[eventName](eventData);
        }
    }



    /**
     * Fetch the gateway endpoint then attempt to establish a 
     * websocket connection.
     * @private
     */
    async _gatewayConnect() {
        this.loga.log('Requesting endpoint');
        const endpoint = this.isBot ? '/gateway/bot' : '/gateway';
        const gateway = await this._apiRequest('GET', endpoint);

        this.shardCount = gateway.shards;
        
        //if attempting to resume the connection, end the old one.
        if (this.resuming) {
            this.socket.socket.end();
            delete this.socket;
        }
        
        this.loga.log(`Connecting to '${gateway.url}'`);
        
        this.socket = nocket.createConnection(gateway.url);
        
        this.socket.on('data', data => {
            try {
                this._handleGatewayObject(JSON.parse(data));
            }
            catch {
                this.loga.log("Couldn't handle a gateway object");
                this.loga.log(data);
            }
        });
        
        this.socket.on('end', () => {
            this.loga.log('End of socket');
            
            clearInterval(this.heartbeatIntervalObj);
        });
        
        this.socket.on('host_disconnect', data => {
            this.loga.error(`Socket disconnected by host: ${data}`);
        });
    }
    
    
    
    /** Begin the process of reconnecting to the gateway. */
    reconnect() {
        this.resuming = true;
        clearInterval(this.heartbeatIntervalObj);
        this.heartbeatAcknowledged = true;
        this._gatewayConnect();
    }
    
    
    
    /**
     * Register a callback to be run whenever the specified
     * dispatch event is received. Accepts either format for the event
     * names.
     * @param {string} eventName - The name of the event. Not case sensitive and accepts both spaces and underscores.
     * @param {function} callback - The function to be run when the given event occurs.
     */
    onEvent(eventName, callback) {
        const eName = eventName.toUpperCase().replaceAll(' ', '_');
        this.dispatchCallbacks[eName] = callback;
    }
    
    
    
    /**
     * Register a callback to be run whenever a message is received that
     * begins with this.commandChar followed by keyWord.
     * @param {*} keyWord 
     * @param {*} callback 
     */
    registerCommand(keyWord, callback) {
        this.commandCallbacks[keyWord.toLowerCase()] = callback;
    }



    /**
     * Send a presence or status update to the gateway.
     * @param {string} status - The user's new status.
     * @param {Object} game - Null, or the user's new activity.
     * @param {int} since - Unix time (in milliseconds) of when the client
     * went idle, or null if the client is not idle.
     * @param {boolean} afk 
     */
    statusUpdate(status, game = null, since = null, afk = false) {
        this._sendOpcode(3, {
            since: since,
            game: game,
            status: status,
            afk: afk
        });
    }
    
    
    
    /**
     * Post a message to a guild text or DM channel.
     * If operating on a guild channel, this endpoint requires
     * the 'SEND_MESSAGES' permission to be present on the current
     * user. If the tts field is set to true, the SEND_TTS_MESSAGES
     * permission is required for the message to be spoken. 
     * Returns a message object. Fires a Message Create Gateway event.
     * 
     * The maximum request size when sending a message is 8MB. 
     * @param {string} channelID - ID of the channel to send to. 
     * @param {string} content - The message contents.
     */
    async createMessage(channelID, content) {
        return this._apiRequest('POST', `/channels/${channelID}/messages`, 
            { content });
    }
    
    
    
    /**
     * Join the specified voice channel.
     * @param {string} channelID - Voice channel ID. 
     * @param {*} selfMute - Is the client muted.
     * @param {*} selfDeaf - Is the client deafened.
     */
    async joinVoiceChannel(
        channelID,
        selfMute = false,
        selfDeaf = false
    ) {
        //get the channel object of the specified channel
        //from the API.
        const channelObj = await this._apiRequest('GET', `/channels/${channelID}`);
        const guildID = channelObj.guild_id;
        
        if (channelObj) {
            if (channelObj.type === 2) {
                this._sendOpcode(4, {
                    guild_id: channelObj.guild_id,
                    channel_id: channelID,
                    self_mute: selfMute,
                    self_deaf: selfDeaf
                });   
            } else {
                this.loga.warning('joinVoiceChannel called on a non-voice channel');
            }
        } else {
            this.loga.warning('joinVoiceChannel called with an invalid channel ID')
        }           
    }



    /**
     * Leave any connected voice channel in a guild. You don't
     * need the channel ID because you can only be in one voice
     * channel per guild.
     * @param {string} guildID - The ID of the guild with a connected voice channel.
     */
    leaveVoiceChannel(guildID) {
        this._sendOpcode(4, {
            guild_id: guildID,
            channel_id: null,
            self_mute: false,
            self_deaf: false
        });
    }
}

module.exports = Client;