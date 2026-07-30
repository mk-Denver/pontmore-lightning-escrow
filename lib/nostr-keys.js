'use strict';

const { bech32 } = require('@scure/base');

function decodeNsec(nsec) {
  if (!nsec) throw new Error('OPERATOR_NSEC is not set in .env');
  if (/^[0-9a-f]{64}$/i.test(nsec)) return nsec.toLowerCase();
  if (nsec.startsWith('nsec1')) {
    const decoded = bech32.decodeToBytes(nsec);
    if (decoded.prefix !== 'nsec') throw new Error('Not a valid nsec');
    return Buffer.from(decoded.bytes).toString('hex');
  }
  throw new Error('OPERATOR_NSEC must be nsec1... or 64-char hex');
}

module.exports = { decodeNsec };
