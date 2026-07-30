'use strict';

const http = require('http');
const { Readable } = require('stream');
const { app, init } = require('../server.js');

// Kick off backend init in the background; don't block the handler.
init().catch((err) => console.error('[startup] background init failed:', err.message));

module.exports = async ({ req, res, log, error }) => {
  const scheme = req.scheme || 'https';
  const host = req.host || '';
  const path = req.path || '/';
  const queryString = req.queryString || '';
  const url = queryString ? `${path}?${queryString}` : path;
  const bodyText = req.bodyText || '';
  const headers = { ...req.headers };
  if (host && !headers.host) headers.host = host;
  headers['x-forwarded-proto'] = scheme;

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      log('[adapter] request timed out after 25s');
      resolve(res.text('Gateway Timeout', 504, { 'content-type': 'text/plain' }));
    }, 25000);

    const mockReq = new Readable({ read() {} });
    Object.setPrototypeOf(mockReq, http.IncomingMessage.prototype);
    http.IncomingMessage.call(mockReq);

    mockReq.method = req.method;
    mockReq.url = url;
    mockReq.headers = headers;
    mockReq.httpVersion = '1.1';
    mockReq.httpVersionMajor = 1;
    mockReq.httpVersionMinor = 1;
    mockReq.socket = { remoteAddress: req.headers['x-appwrite-client-ip'] || '127.0.0.1', encrypted: scheme === 'https' };

    if (bodyText) mockReq.push(Buffer.from(bodyText));
    mockReq.push(null);

    const mockRes = new http.ServerResponse(mockReq);

    let chunks = [];
    let settled = false;

    const done = (fn) => (...args) => {
      if (!settled) { settled = true; clearTimeout(timeoutId); }
      return fn(...args);
    };

    const origWrite = mockRes.write.bind(mockRes);
    const origEnd = mockRes.end.bind(mockRes);

    mockRes.write = function (chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      return origWrite(chunk);
    };

    mockRes.end = done(function (chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      origEnd();

      const status = mockRes.statusCode || 200;
      const respHeaders = mockRes.getHeaders();
      const body = Buffer.concat(chunks).toString('utf8');

      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = body; }

      if (typeof parsed === 'object' && parsed !== null) {
        resolve(res.json(parsed, status, respHeaders));
      } else {
        resolve(res.text(body, status, respHeaders));
      }
    });

    try {
      app(mockReq, mockRes);
    } catch (err) {
      error('[adapter] route threw: ' + err.message);
      if (!settled) { settled = true; clearTimeout(timeoutId); }
      resolve(res.json({ error: 'internal server error' }, 500));
    }
  });
};
