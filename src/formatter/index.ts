import global from '../utils/window-or-global';
import { isNode } from '../utils/is-node';

const base64Chars         = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const validJSONStartRegex = /^[ \n\r\t]*[{\[]/;

const arrayBufferToBase64 = (arraybuffer) =>
{
    const bytes = new Uint8Array(arraybuffer);
    const len   = bytes.length;
    let base64  = '';

    for (let i = 0; i < len; i += 3)
    {
        base64 += base64Chars[bytes[i] >> 2];
        base64 += base64Chars[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)];
        base64 += base64Chars[((bytes[i + 1] & 15) << 2) | (bytes[i + 2] >> 6)];
        base64 += base64Chars[bytes[i + 2] & 63];
    }

    if ((len % 3) === 2)
    {
        base64 = base64.substring(0, base64.length - 1) + '=';
    }
    else if (len % 3 === 1)
    {
        base64 = base64.substring(0, base64.length - 2) + '==';
    }

    return base64;
};

const binaryToBase64Replacer = (key, value) =>
{
    if (global.ArrayBuffer && value instanceof global.ArrayBuffer)
    {
        return {
            base64: true,
            data  : arrayBufferToBase64(value)
        };
    }
    else if (global.Buffer)
    {
        if (value instanceof global.Buffer)
        {
            return {
                base64: true,
                data  : value.toString('base64')
            };
        }
        // Some versions of Node.js convert Buffers to Objects before they are passed to
        // the replacer function - Because of this, we need to rehydrate Buffers
        // before we can convert them to base64 strings.
        if (value && value.type === 'Buffer' && Array.isArray(value.data))
        {
            let rehydratedBuffer;
            if (global.Buffer.from)
            {
                rehydratedBuffer = global.Buffer.from(value.data);
            }
            else
            {
                rehydratedBuffer = new global.Buffer(value.data);
            }
            return {
                base64: true,
                data  : rehydratedBuffer.toString('base64')
            };
        }
    }
    return value;
};

// Decode the data which was transmitted over the wire to a JavaScript Object in a format which SC understands.
// See encode function below for more details.
export function decode(input: any): any
{
    if (input === null)
    {
        return null;
    }
    // Leave ping or pong message as is
    if (input === '#1' || input === '#2')
    {
        return input;
    }
    const message = input.toString();

    // Performance optimization to detect invalid JSON packet sooner.
    if (!validJSONStartRegex.test(message))
    {
        return message;
    }

    try
    {
        return JSON.parse(message);
    }
    catch (err)
    {
    }
    return message;
}

// Encode a raw JavaScript object (which is in the SC protocol format) into a format for
// transfering it over the wire. In this case, we just convert it into a simple JSON string.
// If you want to create your own custom codec, you can encode the object into any format
// (e.g. binary ArrayBuffer or string with any kind of compression) so long as your decode
// function is able to rehydrate that object back into its original JavaScript Object format
// (which adheres to the SC protocol).
// See https://github.com/TopGunSocket/socketcluster/blob/master/socketcluster-protocol.md
// for details about the SC protocol.
export function encode(object: any): string
{
    // Leave ping or pong message as is
    if (object === '#1' || object === '#2')
    {
        return object;
    }
    return isNode() ? JSON.stringify(object, binaryToBase64Replacer) : JSON.stringify(object);
}