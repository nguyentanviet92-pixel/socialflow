/**
 * Self-update helper for SocialFlow Agent.
 *
 * Two deployment modes:
 *   1. Git clone (dev): `git pull` to update
 *   2. Portable .exe (production): point user to GitHub releases
 *
 * `electron/main.js` calls into this module from the Settings UI; absence of
 * the file crashes the whole app at startup, so even when there's nothing to
 * update we must export every name that's required.
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

function appRoot() {
  // In packaged mode, resourcesPath/app.asar.unpacked is the writable root.
  // In dev, this file sits at <root>/lib/updater.js.
  if (process.resourcesPath) {
    const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked')
    if (fs.existsSync(unpacked)) return unpacked
    const app = path.join(process.resourcesPath, 'app')
    if (fs.existsSync(app)) return app
  }
  return path.join(__dirname, '..')
}

function getLocalVersion() {
  try {
    const pkg = require(path.join(appRoot(), 'package.json'))
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function isGitRepo() {
  try {
    return fs.existsSync(path.join(appRoot(), '.git'))
  } catch {
    return false
  }
}

/**
 * Check GitHub releases for a newer version.
 * Returns { hasUpdate: bool, latest?: string, current: string, error?: string }.
 *
 * For now this is intentionally inert — the .exe build doesn't ship with a
 * release-feed URL configured, and main.js handles the "open releases page"
 * fallback when `apply-update` runs in non-git mode. We return hasUpdate=false
 * so the UI shows "up to date" instead of crashing.
 */
async function checkForUpdate() {
  return {
    hasUpdate: false,
    current: getLocalVersion(),
    latest: getLocalVersion(),
  }
}

/**
 * Pull the latest version. Only meaningful in git-clone mode.
 * Portable .exe mode: main.js short-circuits to opening the releases page
 * before this function is called, so we never reach git logic there.
 */
async function pullUpdate() {
  if (!isGitRepo()) {
    return { success: false, message: 'Not a git repo — download new exe from releases page' }
  }
  try {
    const out = execSync('git pull --ff-only', { cwd: appRoot(), encoding: 'utf8', timeout: 60000 })
    return { success: true, message: out.trim() || 'Already up to date' }
  } catch (err) {
    return { success: false, message: err.message }
  }
}

module.exports = { checkForUpdate, pullUpdate, getLocalVersion, isGitRepo }
