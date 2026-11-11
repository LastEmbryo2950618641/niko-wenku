import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { ArchiveError } from './library.mjs';

const font = [
  '01110100011001110101110011000101110', '00100011000010000100001000010001110',
  '01110100010000100010001000100011111', '11110000010000101110000010000111110',
  '00010001100101010010111110001000010', '11111100001000011110000010000111110',
  '01110100001000011110100011000101110', '11111000010001000100010000100001000',
  '01110100011000101110100011000101110', '01110100011000101111000010000101110'
];
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const label = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([label, data])));
  return Buffer.concat([length, label, data, crc]);
}
function png(answer) {
  const width = 180, height = 56, stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height, 245);
  for (let y = 0; y < height; y++) pixels[y * stride] = 0;
  const dot = (x, y, color) => {
    if (x >= 0 && x < width && y >= 0 && y < height) for (let c = 0; c < 3; c++) pixels[y * stride + 1 + x * 3 + c] = color[c];
  };
  for (let i = 0; i < 700; i++) dot(randomInt(width), randomInt(height), [185, 210, 190]);
  [...answer].forEach((digit, index) => {
    const glyph = font[Number(digit)], x = 13 + index * 33, y = randomInt(11, 18), color = [randomInt(25, 80), randomInt(65, 110), randomInt(35, 85)];
    for (let row = 0; row < 7; row++) for (let col = 0; col < 5; col++) if (glyph[row * 5 + col] === '1') {
      for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) dot(x + col * 4 + a, y + row * 4 + b, color);
    }
  });
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

export function createCaptchaService({ makeAnswer = () => String(randomInt(10000, 100000)), now = Date.now } = {}) {
  const challenges = new Map();
  const clientCookie = 'archive_captcha';
  const client = req => String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(clientCookie + '='))?.slice(clientCookie.length + 1);
  function valid(req, challenge) { return challenge && challenge.expiresAt > now() && challenge.client === client(req); }
  return {
    issue(req, res, purpose, secure) {
      if (!['register', 'login'].includes(purpose)) throw new ArchiveError('验证码用途无效', 400);
      let binding = client(req);
      if (!/^[a-f0-9]{64}$/.test(binding || '')) {
        binding = randomBytes(32).toString('hex');
        res.setHeader('Set-Cookie', clientCookie + '=' + binding + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600' + (secure ? '; Secure' : ''));
      }
      for (const [id, value] of challenges) if (value.expiresAt <= now() || (value.client === binding && value.purpose === purpose)) challenges.delete(id);
      if (challenges.size >= 512) challenges.delete(challenges.keys().next().value);
      const id = randomBytes(24).toString('hex'), answer = makeAnswer();
      const expiresAt = now() + 5 * 60 * 1000;
      challenges.set(id, { client: binding, purpose, expiresAt, answer, image: png(answer) });
      return { id, imageUrl: '/api/auth/captcha/' + id + '.png', expiresAt: new Date(expiresAt).toISOString() };
    },
    image(req, id) {
      const challenge = challenges.get(id);
      if (!valid(req, challenge)) throw new ArchiveError('验证码已过期，请刷新', 404);
      return challenge.image;
    },
    verify(req, payload, purpose) {
      const challenge = challenges.get(payload?.captchaId);
      // Consume before any asynchronous password operation: one image, one attempt.
      if (valid(req, challenge)) challenges.delete(payload.captchaId);
      const answer = typeof payload?.captcha === 'string' ? payload.captcha.trim() : '';
      if (!valid(req, challenge) || challenge.purpose !== purpose || !/^\d{5}$/.test(answer) || !timingSafeEqual(Buffer.from(answer), Buffer.from(challenge.answer))) throw new ArchiveError('验证码错误或已过期，请刷新后重试', 400);
    }
  };
}
