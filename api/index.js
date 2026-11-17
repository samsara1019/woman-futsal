'use strict';
// Vercel 진입점. vercel.json이 정적 파일(public/) 외의 모든 경로를 여기로 보낸다.
module.exports = require('../lib/app').listener;
