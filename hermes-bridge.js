/**
 * hermes-bridge.js — WebSocket bridge to Hermes CLI
 * 
 * Spawns a Hermes CLI process for each connected WebSocket client,
 * streams stdout/stderr to the browser, and forwards commands from
 * the browser into stdin.
 *
 * Usage:
 *   BRIDGE_SECRET=mysecret node hermes-bridge.js
 *   pm2 start hermes-bridge.js --name hermes-bridge
 */
const { WebSocketServer } = require('ws')
const { spawn } = require('child_process')
const path = require('path')

const PORT = parseInt(process.env.BRIDGE_PORT || '8765', 10)
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || ''
const HERMES_BIN = process.env.HERMES_BIN || '/root/.local/bin/hermes'

const wss = new WebSocketServer({ port: PORT })

console.log(`[hermes-bridge] Listening on ws://0.0.0.0:${PORT}`)
if (BRIDGE_SECRET) console.log('[hermes-bridge] Auth enabled (BRIDGE_SECRET is set)')

wss.on('connection', (ws, req) => {
  // ── Auth check ──
  if (BRIDGE_SECRET) {
    const url = new URL(req.url, 'http://localhost')
    const token = url.searchParams.get('token')
    if (token !== BRIDGE_SECRET) {
      ws.send(JSON.stringify({ type: 'error', data: 'Unauthorized — invalid token\n' }))
      ws.close(1008, 'Unauthorized')
      return
    }
  }

  const clientIp = req.socket.remoteAddress
  console.log(`[hermes-bridge] Client connected from ${clientIp}`)

  let hermesProc = null
  let isAlive = true

  ws.on('close', () => {
    isAlive = false
    if (hermesProc) {
      console.log(`[hermes-bridge] Client disconnected, killing hermes pid=${hermesProc.pid}`)
      hermesProc.kill('SIGTERM')
      hermesProc = null
    }
  })

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    // ── Spawn a new hermes process ──
    if (msg.type === 'spawn') {
      if (hermesProc) {
        hermesProc.kill('SIGTERM')
        hermesProc = null
      }

      const args = msg.args || []
      console.log(`[hermes-bridge] Spawning: ${HERMES_BIN} ${args.join(' ')}`)

      hermesProc = spawn(HERMES_BIN, args, {
        env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
        cwd: process.env.HOME || '/root',
      })

      hermesProc.stdout.on('data', (chunk) => {
        if (isAlive) ws.send(JSON.stringify({ type: 'stdout', data: chunk.toString() }))
      })

      hermesProc.stderr.on('data', (chunk) => {
        if (isAlive) ws.send(JSON.stringify({ type: 'stderr', data: chunk.toString() }))
      })

      hermesProc.on('close', (code) => {
        if (isAlive) {
          ws.send(JSON.stringify({ type: 'exit', code }))
          console.log(`[hermes-bridge] Hermes exited with code ${code}`)
        }
        hermesProc = null
      })

      hermesProc.on('error', (err) => {
        if (isAlive) ws.send(JSON.stringify({ type: 'error', data: `Spawn error: ${err.message}\n` }))
        hermesProc = null
      })

      return
    }

    // ── Send stdin to running process ──
    if (msg.type === 'stdin' && hermesProc && hermesProc.stdin.writable) {
      hermesProc.stdin.write(msg.data)
      return
    }

    // ── One-shot command: spawn, run, collect, return ──
    if (msg.type === 'exec') {
      const args = msg.args || []
      console.log(`[hermes-bridge] Exec: ${HERMES_BIN} ${args.join(' ')}`)

      const child = spawn(HERMES_BIN, args, {
        env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
        cwd: process.env.HOME || '/root',
      })

      child.stdout.on('data', (chunk) => {
        if (isAlive) ws.send(JSON.stringify({ type: 'stdout', data: chunk.toString() }))
      })

      child.stderr.on('data', (chunk) => {
        if (isAlive) ws.send(JSON.stringify({ type: 'stderr', data: chunk.toString() }))
      })

      child.on('close', (code) => {
        if (isAlive) ws.send(JSON.stringify({ type: 'exit', code }))
      })

      child.on('error', (err) => {
        if (isAlive) ws.send(JSON.stringify({ type: 'error', data: `Exec error: ${err.message}\n` }))
      })

      return
    }

    // ── Kill running process ──
    if (msg.type === 'kill' && hermesProc) {
      hermesProc.kill('SIGTERM')
      return
    }
  })

  // Send welcome
  ws.send(JSON.stringify({
    type: 'stdout',
    data: '🧠 Hermes CLI Bridge connected. Use shortcuts or type commands below.\n\n'
  }))
})
