import { AGChannelClient } from '../ag-channel/client';
import { AsyncStreamEmitter } from '../async-stream-emitter';
import { SocketProtocolErrorStatuses, SocketProtocolIgnoreStatuses } from '../sc-errors/types';
import { AGAuthEngine, AuthStates, AuthToken, ClientOptions, ProtocolVersions, SignedAuthToken, States } from './types';
import { AGTransport } from './transport';
import { CodecEngine } from '../socket-server/types';
import {
    InvalidArgumentsError,
    InvalidMessageError,
    socketProtocolErrorStatuses,
    socketProtocolIgnoreStatuses
} from '../sc-errors/errors';
import { StreamDemux } from '../stream-demux';
import { Item, LinkedList } from '../linked-list';
import { AuthEngine } from './auth';
import { formatter } from '../sc-formatter';
import { wait } from './wait';
import { Buffer } from 'buffer/';

const isBrowser = typeof window !== 'undefined';

export class AGClientSocket extends AsyncStreamEmitter<any> implements AGChannelClient
{
    static readonly CONNECTING: States = 'connecting';
    static readonly OPEN: States       = 'open';
    static readonly CLOSED: States     = 'closed';

    static readonly AUTHENTICATED: AuthStates   = 'authenticated';
    static readonly UNAUTHENTICATED: AuthStates = 'unauthenticated';

    static readonly SUBSCRIBED   = 'subscribed';
    static readonly PENDING      = 'pending';
    static readonly UNSUBSCRIBED = 'unsubscribed';

    static readonly ignoreStatuses: SocketProtocolIgnoreStatuses = socketProtocolIgnoreStatuses;
    static readonly errorStatuses: SocketProtocolErrorStatuses   = socketProtocolErrorStatuses;

    options: ClientOptions;

    id: string|null;
    clientId?: string|undefined;

    version: string|null;
    protocolVersion: ProtocolVersions;

    state: States;

    authState: AuthStates;
    signedAuthToken: SignedAuthToken|null;
    authToken: AuthToken|null;
    authTokenName: string;

    wsOptions?: ClientOptions|undefined;

    pendingReconnect: boolean;
    pendingReconnectTimeout: number;

    preparingPendingSubscriptions: boolean;

    ackTimeout: number;
    connectTimeout: number;

    pingTimeout: number;
    pingTimeoutDisabled: boolean;

    channelPrefix: string|null;
    disconnectOnUnload: boolean;

    connectAttempts: number;

    isBatching: boolean;
    batchOnHandshake: boolean;
    batchOnHandshakeDuration: number;

    auth: AGAuthEngine;
    codec: CodecEngine;
    transport?: AGTransport|undefined;

    poolIndex?: number|undefined;
    private _batchingIntervalId: any;
    private _outboundBuffer: LinkedList<Item>;
    private _channelMap: {[key: string]: any};
    private _channelEventDemux: StreamDemux<unknown>;
    private _channelDataDemux: StreamDemux<unknown>;
    private _receiverDemux: StreamDemux<unknown>;
    private _procedureDemux: StreamDemux<unknown>;
    private _cid: number;

    private _privateDataHandlerMap = {
        '#publish'        : function (data)
        {
            let undecoratedChannelName = this._undecorateChannelName(data.channel);
            let isSubscribed           = this.isSubscribed(undecoratedChannelName, true);

            if (isSubscribed)
            {
                this._channelDataDemux.write(undecoratedChannelName, data.data);
            }
        },
        '#kickOut'        : function (data)
        {
            let undecoratedChannelName = this._undecorateChannelName(data.channel);
            let channel                = this._channelMap[undecoratedChannelName];
            if (channel)
            {
                this.emit('kickOut', {
                    channel: undecoratedChannelName,
                    message: data.message
                });
                this._channelEventDemux.write(`${undecoratedChannelName}/kickOut`, { message: data.message });
                this._triggerChannelUnsubscribe(channel);
            }
        },
        '#setAuthToken'   : function (data)
        {
            if (data)
            {
                this._setAuthToken(data);
            }
        },
        '#removeAuthToken': function (data)
        {
            this._removeAuthToken(data);
        }
    };

    private _privateRPCHandlerMap = {
        '#setAuthToken'   : function (data, request)
        {
            if (data)
            {
                this._setAuthToken(data);

                request.end();
            }
            else
            {
                request.error(new InvalidMessageError('No token data provided by #setAuthToken event'));
            }
        },
        '#removeAuthToken': function (data, request)
        {
            this._removeAuthToken(data);
            request.end();
        }
    };

    /**
     * Constructor
     */
    constructor(socketOptions: ClientOptions)
    {
        super();

        let defaultOptions: ClientOptions = {
            path                    : '/topgunsocket/',
            secure                  : false,
            protocolScheme          : null,
            socketPath              : null,
            autoConnect             : true,
            autoReconnect           : true,
            autoSubscribeOnConnect  : true,
            connectTimeout          : 20000,
            ackTimeout              : 10000,
            timestampRequests       : false,
            timestampParam          : 't',
            authTokenName           : 'topgunsocket.authToken',
            binaryType              : 'arraybuffer',
            batchOnHandshake        : false,
            batchOnHandshakeDuration: 100,
            batchInterval           : 50,
            protocolVersion         : 2,
            wsOptions               : {},
            cloneData               : false
        };
        const opts: ClientOptions         = Object.assign(defaultOptions, socketOptions);

        this.id                            = null;
        this.version                       = opts.version || null;
        this.protocolVersion               = opts.protocolVersion;
        this.state                         = AGClientSocket.CLOSED;
        this.authState                     = AGClientSocket.UNAUTHENTICATED;
        this.signedAuthToken               = null;
        this.authToken                     = null;
        this.pendingReconnect              = false;
        this.pendingReconnectTimeout       = null;
        this.preparingPendingSubscriptions = false;
        this.clientId                      = opts.clientId;
        this.wsOptions                     = opts.wsOptions;

        this.connectTimeout     = opts.connectTimeout;
        this.ackTimeout         = opts.ackTimeout;
        this.channelPrefix      = opts.channelPrefix || null;
        this.disconnectOnUnload = opts.disconnectOnUnload == null ? true : opts.disconnectOnUnload;
        this.authTokenName      = opts.authTokenName;

        // pingTimeout will be connectTimeout at the start, but it will
        // be updated with values provided by the 'connect' event
        opts.pingTimeout         = opts.connectTimeout;
        this.pingTimeout         = opts.pingTimeout;
        this.pingTimeoutDisabled = !!opts.pingTimeoutDisabled;

        let maxTimeout = Math.pow(2, 31) - 1;

        let verifyDuration = (propertyName) =>
        {
            if (this[propertyName] > maxTimeout)
            {
                throw new InvalidArgumentsError(
                    `The ${propertyName} value provided exceeded the maximum amount allowed`
                );
            }
        };

        verifyDuration('connectTimeout');
        verifyDuration('ackTimeout');
        verifyDuration('pingTimeout');

        this.connectAttempts = 0;

        this.isBatching               = false;
        this.batchOnHandshake         = opts.batchOnHandshake;
        this.batchOnHandshakeDuration = opts.batchOnHandshakeDuration;

        this._batchingIntervalId = null;
        this._outboundBuffer     = new LinkedList();
        this._channelMap         = {};

        this._channelEventDemux = new StreamDemux();
        this._channelDataDemux  = new StreamDemux();

        this._receiverDemux  = new StreamDemux();
        this._procedureDemux = new StreamDemux();

        this.options = opts;

        this._cid = 1;

        this.options.callIdGenerator = () =>
        {
            return this._cid++;
        };

        if (this.options.autoReconnect)
        {
            if (this.options.autoReconnectOptions == null)
            {
                this.options.autoReconnectOptions = {};
            }

            // Add properties to the this.options.autoReconnectOptions object.
            // We assign the reference to a reconnectOptions variable to avoid repetition.
            let reconnectOptions = this.options.autoReconnectOptions;
            if (reconnectOptions.initialDelay == null)
            {
                reconnectOptions.initialDelay = 10000;
            }
            if (reconnectOptions.randomness == null)
            {
                reconnectOptions.randomness = 10000;
            }
            if (reconnectOptions.multiplier == null)
            {
                reconnectOptions.multiplier = 1.5;
            }
            if (reconnectOptions.maxDelay == null)
            {
                reconnectOptions.maxDelay = 60000;
            }
        }

        if (this.options.subscriptionRetryOptions == null)
        {
            this.options.subscriptionRetryOptions = {};
        }

        if (this.options.authEngine)
        {
            this.auth = this.options.authEngine;
        }
        else
        {
            this.auth = new AuthEngine();
        }

        if (this.options.codecEngine)
        {
            this.codec = this.options.codecEngine;
        }
        else
        {
            // Default codec engine
            this.codec = formatter;
        }

        if (this.options['protocol'])
        {
            let protocolOptionError = new InvalidArgumentsError(
                'The "protocol" option does not affect socketcluster-client - ' +
                'If you want to utilize SSL/TLS, use "secure" option instead'
            );
            this._onError(protocolOptionError);
        }

        this.options.query = opts.query || {};
        if (typeof this.options.query === 'string')
        {
            let searchParams = new URLSearchParams(this.options.query);
            let queryObject  = {};
            for (let [key, value] of searchParams.entries())
            {
                let currentValue = queryObject[key];
                if (currentValue == null)
                {
                    queryObject[key] = value;
                }
                else
                {
                    if (!Array.isArray(currentValue))
                    {
                        queryObject[key] = [currentValue];
                    }
                    queryObject[key].push(value);
                }
            }
            this.options.query = queryObject;
        }

        if (isBrowser && this.disconnectOnUnload && global.addEventListener && global.removeEventListener)
        {
            this._handleBrowserUnload();
        }

        if (this.options.autoConnect)
        {
            this.connect();
        }
    }

    // -----------------------------------------------------------------------------------------------------
    // @ Accessors
    // -----------------------------------------------------------------------------------------------------

    get isBufferingBatch(): boolean
    {
        return this.transport.isBufferingBatch;
    }

    // -----------------------------------------------------------------------------------------------------
    // @ Public methods
    // -----------------------------------------------------------------------------------------------------

    getBackpressure(): number
    {
        return Math.max(
            this.getAllListenersBackpressure(),
            this.getAllReceiversBackpressure(),
            this.getAllProceduresBackpressure(),
            this.getAllChannelsBackpressure()
        );
    }

    getState(): States
    {
        return this.state;
    }

    getBytesReceived(): any
    {
        return this.transport.getBytesReceived();
    }

    async deauthenticate(): Promise<void>
    {
        (async () =>
        {
            let oldAuthToken;
            try
            {
                oldAuthToken = await this.auth.removeToken(this.authTokenName);
            }
            catch (err)
            {
                this._onError(err);
                return;
            }
            this.emit('removeAuthToken', { oldAuthToken });
        })();

        if (this.state !== AGClientSocket.CLOSED)
        {
            this.transmit('#removeAuthToken');
        }
        this._changeToUnauthenticatedStateAndClearTokens();
        await wait(0);
    }

    connect(): void
    {
        if (this.state === AGClientSocket.CLOSED)
        {
            this.pendingReconnect        = false;
            this.pendingReconnectTimeout = null;
            clearTimeout(this._reconnectTimeoutRef);

            this.state = AGClientSocket.CONNECTING;
            this.emit('connecting', {});

            if (this.transport)
            {
                this.transport.clearAllListeners();
            }

            let transportHandlers = {
                onOpen           : (value) =>
                {
                    this.state = AGClientSocket.OPEN;
                    this._onOpen(value);
                },
                onOpenAbort      : (value) =>
                {
                    if (this.state !== AGClientSocket.CLOSED)
                    {
                        this.state = AGClientSocket.CLOSED;
                        this._destroy(value.code, value.reason, true);
                    }
                },
                onClose          : (value) =>
                {
                    if (this.state !== AGClientSocket.CLOSED)
                    {
                        this.state = AGClientSocket.CLOSED;
                        this._destroy(value.code, value.reason);
                    }
                },
                onEvent          : (value) =>
                {
                    this.emit(value.event, value.data);
                },
                onError          : (value) =>
                {
                    this._onError(value.error);
                },
                onInboundInvoke  : (value) =>
                {
                    this._onInboundInvoke(value);
                },
                onInboundTransmit: (value) =>
                {
                    this._onInboundTransmit(value.event, value.data);
                }
            };

            this.transport = new AGTransport(this.auth, this.codec, this.options, this.wsOptions, transportHandlers);
        }
    }

    reconnect(code?: number, reason?: string): void
    {
        this.disconnect(code, reason);
        this.connect();
    }

    disconnect(code?: number, reason?: string): void
    {
        code = code || 1000;

        if (typeof code !== 'number')
        {
            throw new InvalidArgumentsError('If specified, the code argument must be a number');
        }

        let isConnecting = this.state === AGClientSocket.CONNECTING;
        if (isConnecting || this.state === AGClientSocket.OPEN)
        {
            this.state = AGClientSocket.CLOSED;
            this._destroy(code, reason, isConnecting);
            this.transport.close(code, reason);
        }
        else
        {
            this.pendingReconnect        = false;
            this.pendingReconnectTimeout = null;
            clearTimeout(this._reconnectTimeoutRef);
        }
    }

    decodeBase64(encodedString: string): string
    {
        return Buffer.from(encodedString, 'base64').toString('utf8');
    }

    // -----------------------------------------------------------------------------------------------------
    // @ Private methods
    // -----------------------------------------------------------------------------------------------------

    private _changeToAuthenticatedState(signedAuthToken): void
    {
        this.signedAuthToken = signedAuthToken;
        this.authToken       = this._extractAuthTokenData(signedAuthToken);

        if (this.authState !== AGClientSocket.AUTHENTICATED)
        {
            let oldAuthState    = this.authState;
            this.authState      = AGClientSocket.AUTHENTICATED;
            let stateChangeData = {
                oldAuthState,
                newAuthState   : this.authState,
                signedAuthToken: signedAuthToken,
                authToken      : this.authToken
            };
            if (!this.preparingPendingSubscriptions)
            {
                this.processPendingSubscriptions();
            }

            this.emit('authStateChange', stateChangeData);
        }
        this.emit('authenticate', { signedAuthToken, authToken: this.authToken });
    }

    private _changeToUnauthenticatedStateAndClearTokens(): void
    {
        if (this.authState !== AGClientSocket.UNAUTHENTICATED)
        {
            let oldAuthState       = this.authState;
            let oldAuthToken       = this.authToken;
            let oldSignedAuthToken = this.signedAuthToken;
            this.authState         = AGClientSocket.UNAUTHENTICATED;
            this.signedAuthToken   = null;
            this.authToken         = null;

            let stateChangeData = {
                oldAuthState,
                newAuthState: this.authState
            };
            this.emit('authStateChange', stateChangeData);
            this.emit('deauthenticate', { oldSignedAuthToken, oldAuthToken });
        }
    }

    private async _handleBrowserUnload(): Promise<void>
    {
        let unloadHandler           = () =>
        {
            this.disconnect();
        };
        let isUnloadHandlerAttached = false;

        let attachUnloadHandler = () =>
        {
            if (!isUnloadHandlerAttached)
            {
                isUnloadHandlerAttached = true;
                global.addEventListener('beforeunload', unloadHandler, false);
            }
        };

        let detachUnloadHandler = () =>
        {
            if (isUnloadHandlerAttached)
            {
                isUnloadHandlerAttached = false;
                global.removeEventListener('beforeunload', unloadHandler, false);
            }
        };

        (async () =>
        {
            let consumer = this.listener('connecting').createConsumer();
            while (true)
            {
                let packet = await consumer.next();
                if (packet.done) break;
                attachUnloadHandler();
            }
        })();

        (async () =>
        {
            let consumer = this.listener('close').createConsumer();
            while (true)
            {
                let packet = await consumer.next();
                if (packet.done) break;
                detachUnloadHandler();
            }
        })();
    }

    private _setAuthToken(data)
    {
        this._changeToAuthenticatedState(data.token);

        (async () =>
        {
            try
            {
                await this.auth.saveToken(this.authTokenName, data.token, {});
            }
            catch (err)
            {
                this._onError(err);
            }
        })();
    }

    private _removeAuthToken(data): void
    {
        (async () =>
        {
            let oldAuthToken;
            try
            {
                oldAuthToken = await this.auth.removeToken(this.authTokenName);
            }
            catch (err)
            {
                // Non-fatal error - Do not close the connection
                this._onError(err);
                return;
            }
            this.emit('removeAuthToken', { oldAuthToken });
        })();

        this._changeToUnauthenticatedStateAndClearTokens();
    }
}