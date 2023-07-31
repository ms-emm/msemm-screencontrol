import https from 'https';
import { isValidNonce } from './nonceHandler.js';
import { GoogleToken } from 'gtoken';

const ANDROID_APP_PACKAGE = process.env.ANDROID_APP_PACKAGE;
const ANDROID_APP_CERT256 = process.env.ANDROID_APP_CERT256;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY.split('\\n').join('\n');

const SERVER_ORIGIN = process.env.SERVER_ORIGIN;
const TURNSTYLE_SECRET_KEY = process.env.TURNSTYLE_SECRET_KEY;

const HOST_TOKEN_TIMEOUT = 10 * 60 * 1000; // 10 minutes

// https://github.com/googleapis/node-gtoken
const gtoken = new GoogleToken({
  email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
  scope: ['https://www.googleapis.com/auth/playintegrity'],
  key: GOOGLE_SERVICE_ACCOUNT_KEY,
  eagerRefreshThresholdMillis: 5 * 60 * 1000 // 5 minutes
}); //todo ensure it's always valid

export default async function (socket, next) {
  try {
    const hostToken = socket.handshake.auth.hostToken;
    const clientToken = socket.handshake.auth.clientToken;

    if (!hostToken && !clientToken) throw new Error('NO_TOKEN_FOUND');

    if (clientToken) {
      console.debug(JSON.stringify({ socket: socket.id, message: clientToken }));

      const data = JSON.stringify({ 'secret': TURNSTYLE_SECRET_KEY, 'response': clientToken });

      const options = {
        hostname: 'challenges.cloudflare.com',
        port: 443,
        path: '/turnstile/v0/siteverify',
        method: 'POST',
        timeout: 3000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
      };

      const outcome = await doRequest(options, data);

      if (outcome.success !== true) throw new Error(`TURNSTYLE_INVALID_TOKEN:${outcome['error-codes']}`);
      if (outcome.hostname !== SERVER_ORIGIN) throw new Error(`TURNSTYLE_INVALID_HOSTNAME:${outcome.hostname}`);
      if (!outcome.cdata || typeof outcome.cdata !== 'string' || outcome.cdata.length === 0) throw new Error(`TURNSTYLE_INVALID_CLIENT_ID:${outcome.cdata}`);

      socket.data.isHost = false;
      socket.data.isClient = true;
      socket.data.clientId = outcome.cdata;

      next();
      return;
    }

    if (hostToken) {
      const data = JSON.stringify({ integrity_token: hostToken });

      await gtoken.getToken();

      const options = {
        hostname: 'playintegrity.googleapis.com',
        port: 443,
        path: `/v1/${ANDROID_APP_PACKAGE}:decodeIntegrityToken`,
        method: 'POST',
        timeout: 5000,
        headers: { 'Authorization': `Bearer ${gtoken.accessToken}`, 'Content-Type': 'application/json', 'Content-Length': data.length }
      }

      const tokenPayload = await doRequest(options, data);
      const payload = tokenPayload.tokenPayloadExternal;

      console.debug(JSON.stringify({ socket: socket.id, message: payload }));

      if (!payload) throw new Error('EMPTY_PAYLOAD');

      // requestDetails
      if (!payload.requestDetails) throw new Error('EMPTY_REQUEST_DETAILS');

      if (payload.requestDetails.requestPackageName !== ANDROID_APP_PACKAGE) throw new Error(`REQUEST_DETAILS_WRONG_PACKAGE_NAME:${payload.appIntegrity.packageName}`);

      const requestHash = payload.requestDetails.requestHash;

      if (!isValidNonce(requestHash)) throw new Error('INVALID_NONCE');

      if (Date.now() - payload.requestDetails.timestampMillis > HOST_TOKEN_TIMEOUT) throw new Error('TOKEN_EXPIRED');

      // appIntegrity
      if (!payload.appIntegrity) throw new Error('EMPTY_APP_INTEGRITY');

      if (ANDROID_APP_PACKAGE.endsWith('.dev')) { // Dev build
        if (payload.appIntegrity.appRecognitionVerdict !== 'UNRECOGNIZED_VERSION') throw new Error(`WRONG_APP_VERDICT:${payload.appIntegrity.appRecognitionVerdict}`);
      } else {
        if (payload.appIntegrity.appRecognitionVerdict !== 'PLAY_RECOGNIZED') throw new Error(`WRONG_APP_VERDICT:${payload.appIntegrity.appRecognitionVerdict}`);
      }

      if (payload.appIntegrity.packageName !== ANDROID_APP_PACKAGE) throw new Error(`APP_INTEGRITY_WRONG_PACKAGE_NAME:${payload.appIntegrity.packageName}`);

      if (!payload.appIntegrity.certificateSha256Digest.includes(ANDROID_APP_CERT256)) throw new Error('APP_INTEGRITY_WRONG_DIGEST');

      // Don't check for now tokenPayload.appIntegrity.versionCode

      // deviceIntegrity
      if (!payload.deviceIntegrity) throw new Error('EMPTY_DEVICE_INTEGRITY');

      if (!payload.deviceIntegrity.deviceRecognitionVerdict.includes('MEETS_DEVICE_INTEGRITY')) throw new Error(`FAIL_DEVICE_INTEGRITY:${JSON.stringify(payload.deviceIntegrity.deviceRecognitionVerdict)}`);

      // accountDetails 
      // Don't check for now

      socket.data.isHost = true;
      socket.data.isClient = false;
      next();
      return;
    }

  } catch (cause) {
    console.error(JSON.stringify({ socket: socket.id, error: 'TOKEN_VERIFICATION_FAILED', client_address: socket.request.connection.remoteAddress, message: cause.message }));
    next(new Error(`ERROR:TOKEN_VERIFICATION_FAILED:${cause.message}`));
  }

  async function doRequest(options, data) {
    return new Promise((resolve, reject) => {
      const request = https.request(options, (res) => {
        if (res.statusCode < 200 || res.statusCode > 299)
          return reject(new Error(`${res.statusCode}`));

        const body = [];

        res.on('data', chunk => body.push(chunk));

        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(body).toString()));
          } catch (cause) {
            reject(cause);
          }
        });
      });

      request.on('error', err => reject(err));
      request.on('timeout', () => {
        request.destroy();
        reject(new Error(`TIME_OUT:[${options.hostname}]`));
      });

      request.write(data);
      request.end();
    });
  }
}