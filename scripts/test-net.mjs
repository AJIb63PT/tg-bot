#!/usr/bin/env node
/** Запуск всех тестов вместе с сетевыми (обращения к Open-Meteo). */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dir = 'test';
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => path.join(dir, f))
  .sort();

const child = spawn(
  process.execPath,
  ['--test', '--experimental-test-isolation=none', ...files],
  { stdio: 'inherit', env: { ...process.env, TEST_NET: '1' } },
);
child.on('exit', (code) => process.exit(code ?? 0));
