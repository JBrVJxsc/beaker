import { app, dialog, BrowserView, BrowserWindow, Menu, clipboard, ipcMain } from 'electron'
import { EventEmitter } from 'events'
import _throttle from 'lodash.throttle'
import emitStream from 'emit-stream'
import _get from 'lodash.get'
import _pick from 'lodash.pick'
import * as rpc from 'pauls-electron-rpc'
import { Pane } from './pane'
import { PaneLayout } from './pane-layout'
import viewsRPCManifest from '../../rpc-manifests/views'
import * as zoom from './zoom'
import * as shellMenus from '../subwindows/shell-menus'
import * as locationBar from '../subwindows/location-bar'
import * as prompts from '../subwindows/prompts'
import * as permPrompt from '../subwindows/perm-prompt'
import * as modals from '../subwindows/modals'
import * as siteInfo from '../subwindows/site-info'
import * as windowMenu from '../window-menu'
import { createShellWindow, getAddedWindowSettings } from '../windows'
import { examineLocationInput } from '../../../lib/urls'
import { findWebContentsParentWindow } from '../../lib/electron'
import * as sitedataDb from '../../dbs/sitedata'
import * as settingsDb from '../../dbs/settings'
import hyper from '../../hyper/index'

const Y_POSITION = 94

// globals
// =

var tabIdCounter = 1
var activeTabs = {} // map of {[win.id]: Array<Tab>}
var backgroundTabs = [] // Array<Tab>
var preloadedNewTabs = {} // map of {[win.id]: Tab}
var lastSelectedTabIndex = {} // map of {[win.id]: Number}
var closedURLs = {} // map of {[win.id]: Array<string>}
var windowEvents = {} // mapof {[win.id]: EventEmitter}
var defaultUrl = 'beaker://desktop/'

// classes
// =

class Tab extends EventEmitter {
  constructor (win, opts = {isPinned: false, isHidden: false}) {
    super()
    this.id = tabIdCounter++
    this.browserWindow = win
    this.panes = []
    this.layout = new PaneLayout()
    this.layout.on('changed', this.resize.bind(this))

    defineActivePanePassthroughGetter(this, 'url')
    defineActivePanePassthroughGetter(this, 'loadingURL')
    defineActivePanePassthroughGetter(this, 'origin')
    defineActivePanePassthroughGetter(this, 'title')
    defineActivePanePassthroughGetter(this, 'webContents')
    defineActivePanePassthroughGetter(this, 'browserView')
    defineActivePanePassthroughFn(this, 'loadURL')
    defineActivePanePassthroughFn(this, 'focus')
    defineActivePanePassthroughFn(this, 'captureScreenshot')
    defineActivePanePassthroughFn(this, 'showInpageFind')
    defineActivePanePassthroughFn(this, 'hideInpageFind')
    defineActivePanePassthroughFn(this, 'setInpageFindString')
    defineActivePanePassthroughFn(this, 'moveInpageFind')
    defineActivePanePassthroughFn(this, 'toggleLiveReloading')
    defineActivePanePassthroughFn(this, 'stopLiveReloading')

    // browser state
    this.isHidden = opts.isHidden // is this tab hidden from the user? used for the preloaded tab and background tabs
    this.isActive = false // is this the active taba in the window?
    this.isPinned = Boolean(opts.isPinned) // is this tab pinned?

    // always have one pane
    this.createPane()
  }

  get state () {
    var state = this.activePane.state
    return Object.assign(state, {
      isActive: this.isActive,
      isPinned: this.isPinned
    })
  }

  get activePane () {
    return this.panes.find(p => p.isActive)
  }

  get tabBounds () {
    var x = 0
    var y = Y_POSITION
    var {width, height} = this.browserWindow.getContentBounds()
    if (getAddedWindowSettings(this.browserWindow).isShellInterfaceHidden) {
      y = 0
    }
    return {x, y: y, width, height: height - y}
  }

  getIPCSenderInfo (event) {
    for (let pane of this.panes) {
      let info = pane.getIPCSenderInfo(event)
      if (info) return info
    }
    return {url: '', isMainFrame: false}
  }

  // management
  // =

  resize () {
    if (this.isHidden || !this.isActive) return
    this.layout.computePanesBounds(this.tabBounds)
    for (let pane of this.panes) {
      pane.resize(this.layout.getBoundsForPane(pane))
    }
  }

  activate () {
    if (this.isHidden) return
    this.isActive = true

    for (let pane of this.panes) {
      pane.show()
    }

    prompts.show(this)
    permPrompt.show(this)
    modals.show(this)

    this.resize()
    this.emit('activated')
  }

  deactivate () {
    if (this.isHidden) return
    if (!this.browserWindow) return

    for (let pane of this.panes) {
      pane.hide()
    }

    if (this.isActive) {
      shellMenus.hide(this.browserWindow) // this will close the location menu if it's open
    }
    // TODO
    // permPrompt.hide(this)
    // modals.hide(this)
    // siteInfo.hide(this)

    var wasActive = this.isActive
    this.isActive = false
    if (wasActive) {
      this.emit('deactivated')
    }
  }

  destroy () {
    this.deactivate()
    for (let pane of this.panes) {
      pane.destroy()
    }
    permPrompt.close(this)
    modals.close(this)
    this.emit('destroyed')
  }

  awaitActive () {
    return Promise.all(this.panes.map(p => p.awaitActive()))
  }

  transferWindow (targetWindow) {
    this.deactivate()
    prompts.close(this)
    permPrompt.close(this)
    modals.close(this)

    for (let pane of this.panes) {
      pane.browserWindow = this.browserWindow
    }
    this.browserWindow = targetWindow
  }

  toggleMuted () {
    let isMuted = this.panes.reduce((v, pane) => v || pane.isAudioMuted, false)
    for (let pane of this.panes) {
      pane.setAudioMuted(!isMuted)
    }
  }

  // panes
  // =

  setActivePane (pane) {
    if (this.activePane) this.activePane.isActive = false
    pane.isActive = true
    emitUpdateState(this)
  }

  createPane ({after, splitDir} = {after: undefined, splitDir: 'vert'}) {
    var pane = new Pane(this)
    this.panes.push(pane)
    if (!this.activePane) this.setActivePane(pane)
    pane.show()

    if (after) {
      if (splitDir === 'vert') {
        let stack = this.layout.findStack(after)
        this.layout.addPane(pane, {after: stack})
      } else {
        var stack = this.layout.findStack(after)
        this.layout.addPaneToStack(stack, pane, {after: after})
      }
    } else {
      this.layout.addPane(pane)
    }

    return pane
  }

  splitPane (origPane, splitDir = 'vert') {
    var pane = this.createPane({after: origPane, splitDir})
    pane.loadURL(origPane.url)
  }

  removePane (pane) {
    let i = this.panes.indexOf(pane)
    if (i === -1) {
      console.warn('Tried to remove pane that is not on tab', pane, this)
      return
    }
    this.panes.splice(i, 1)
    this.layout.removePane(pane)
    pane.destroy()
    if (this.panes.length === 0) {
      // always have one pane
      remove(this.browserWindow, this)
    } else if (!this.activePane) {
      // choose a new active pane
      this.setActivePane(this.panes[0])
    }
  }

  findPane (browserView) {
    return this.panes.find(p => p.browserView === browserView)
  }

  // state fetching
  // =

  // helper called by UIs to pull latest state if a change event has occurred
  // eg called by the bookmark systems after the bookmark state has changed
  async refreshState () {
    await Promise.all(this.panes.map(p => p.refreshState()))
  }

  // events
  // =

  emitPaneUpdateState (pane) {
    if (this.isHidden) return
    if (!pane.isActive) return
    emitUpdateState(this)
  }
}

// exported api
// =

export async function setup () {
  defaultUrl = String(await settingsDb.get('new_tab'))
  settingsDb.on('set:new_tab', newValue => {
    defaultUrl = newValue

    // reset preloaded tabs since they are now on the wrong URL
    for (let k in preloadedNewTabs) {
      preloadedNewTabs[k].destroy()
    }
    preloadedNewTabs = {}
  })

  // listen for webContents messages
  ipcMain.on('BEAKER_SCRIPTCLOSE_SELF', e => {
    var browserView = BrowserView.fromWebContents(e.sender)
    if (browserView) {
      var tab = findTab(browserView)
      if (tab) remove(tab.browserWindow, tab)
    }
    e.returnValue = false
  })
  ipcMain.on('BEAKER_WC_FOCUSED', e => {
    // when a pane is focused, we want to set it as the
    // active pane of its tab
    var browserView = BrowserView.fromWebContents(e.sender)
    if (!browserView) return
    for (let winId in activeTabs) {
      for (let tab of activeTabs[winId]) {
        var pane = tab.findPane(browserView)
        if (pane) {
          if (tab.activePane !== pane) {
            tab.setActivePane(pane)
          }
          return
        }
      }
    }
  })

  // track daemon connectivity
  hyper.daemon.on('daemon-restored', () => emitReplaceStateAllWindows())
  hyper.daemon.on('daemon-stopped', () => emitReplaceStateAllWindows())

  // track peer-counts
  function iterateTabs (cb) {
    for (let winId in activeTabs) {
      for (let tab of activeTabs[winId]) {
        cb(tab)
      }
    }
  }
  hyper.drives.on('updated', ({details}) => {
    iterateTabs(tab => {
      if (tab.driveInfo && tab.driveInfo.url === details.url) {
        tab.refreshState()
      }
    })
  })
}

export function getAll (win) {
  win = getTopWindow(win)
  return activeTabs[win.id] || []
}

export function getAllAcrossWindows () {
  return activeTabs
}

export function getByIndex (win, index) {
  win = getTopWindow(win)
  if (index === 'active') return getActive(win)
  return getAll(win)[index]
}

export function getIndexOfTab (win, tab) {
  win = getTopWindow(win)
  return getAll(win).indexOf(tab)
}

export function getAllPinned (win) {
  win = getTopWindow(win)
  return getAll(win).filter(p => p.isPinned)
}

export function getActive (win) {
  win = getTopWindow(win)
  return getAll(win).find(tab => tab.isActive)
}

export function findTab (browserView) {
  for (let winId in activeTabs) {
    for (let tab of activeTabs[winId]) {
      if (tab.findPane(browserView)) {
        return tab
      }
    }
  }
  for (let tab of backgroundTabs) {
    if (tab.findPane(browserView)) {
      return tab
    }
  }
}

export function findContainingWindow (browserView) {
  for (let winId in activeTabs) {
    for (let v of activeTabs[winId]) {
      if (v.browserView === browserView) {
        return v.browserWindow
      }
    }
  }
  for (let winId in preloadedNewTabs) {
    if (preloadedNewTabs[winId].browserView === browserView) {
      return preloadedNewTabs[winId].browserWindow
    }
  }
}

export function create (
    win,
    url,
    opts = {
      setActive: false,
      setActiveBySettings: false,
      isPinned: false,
      focusLocationBar: false,
      adjacentActive: false,
      tabIndex: undefined
    }
  ) {
  url = url || defaultUrl
  if (url.startsWith('devtools://')) {
    return // dont create tabs for this
  }
  win = getTopWindow(win)
  var tabs = activeTabs[win.id] = activeTabs[win.id] || []

  var tab
  var preloadedNewTab = preloadedNewTabs[win.id]
  var loadWhenReady = false
  if (url === defaultUrl && !opts.isPinned && preloadedNewTab) {
    // use the preloaded tab
    tab = preloadedNewTab
    tab.isHidden = false // no longer hidden
    preloadedNewTab = preloadedNewTabs[win.id] = null
  } else {
    // create a new tab
    tab = new Tab(win, {isPinned: opts.isPinned})
    loadWhenReady = true
  }

  // add to active tabs
  if (opts.isPinned) {
    tabs.splice(indexOfLastPinnedTab(win), 0, tab)
  } else {
    let tabIndex = (typeof opts.tabIndex !== 'undefined' && opts.tabIndex !== -1) ? opts.tabIndex : undefined
    if (opts.adjacentActive) {
      let active = getActive(win)
      let lastPinIndex = indexOfLastPinnedTab(win)
      tabIndex = active ? tabs.indexOf(active) : undefined
      if (tabIndex === -1) tabIndex = undefined
      else if (tabIndex < lastPinIndex) tabIndex = lastPinIndex
      else tabIndex++
    }
    if (typeof tabIndex !== 'undefined') {
      tabs.splice(tabIndex, 0, tab)
    } else {
      tabs.push(tab)
    }
  }
  if (loadWhenReady) {
    // NOTE
    // `loadURL()` triggers some events (eg app.on('web-contents-created'))
    // which need to be handled *after* the tab is added to the listing
    // thus this `loadWhenReady` logic
    // -prf
    tab.loadURL(url)
  }

  // make active if requested, or if none others are
  let shouldSetActive = opts.setActive
  if (opts.setActiveBySettings) {
    shouldSetActive = Boolean(Number(settingsDb.getCached('new_tabs_in_foreground')))
  }
  if (shouldSetActive || !getActive(win)) {
    setActive(win, tab)
  }
  emitReplaceState(win)

  if (opts.focusLocationBar) {
    win.webContents.send('command', 'focus-location')
  }

  // create a new preloaded tab if needed
  if (!preloadedNewTab) {
    createPreloadedNewTab(win)
  }

  return tab
}

export function createBg (url) {
  var tab = new Tab(undefined, {isHidden: true})
  tab.loadURL(url)
  backgroundTabs.push(tab)
  app.emit('custom-background-tabs-update', backgroundTabs)
}

export async function minimizeToBg (win, tab) {
  win = getTopWindow(win)
  var tabs = getAll(win)
  var i = tabs.indexOf(tab)
  if (i == -1) {
    return console.warn('tabs/manager minimize() called for missing tab', tab)
  }

  // do minimize animation
  win.webContents.send('command', 'minimize-to-bg-anim')

  // set new active if that was
  if (tab.isActive && tabs.length > 1) {
    setActive(win, tabs[i + 1] || tabs[i - 1])
  }

  // move to background
  tabs.splice(i, 1)
  tab.deactivate()
  backgroundTabs.push(tab)
  app.emit('custom-background-tabs-update', backgroundTabs)

  // persist pins w/o this one, if that was
  if (tab.isPinned) savePins(win)

  tab.isPinned = false
  tab.isHidden = true
  tab.browserWindow = undefined

  // create a new empty tab if that was the last one
  if (tabs.length === 0) return create(win, undefined, {setActive: true})
  emitReplaceState(win)
}

export async function restoreBgTabByIndex (win, index) {
  win = getTopWindow(win)
  var tabs = getAll(win)
  
  var tab = backgroundTabs[index]
  if (!tab) return
  backgroundTabs.splice(index, 1)
  app.emit('custom-background-tabs-update', backgroundTabs)

  if (tab.isPinned) {
    tabs.splice(indexOfLastPinnedTab(win), 0, tab)
  } else {
    tabs.push(tab)
  }
  tab.tabCreationTime = Date.now()
  tab.isHidden = false
  tab.browserWindow = win
  setActive(win, tab)
}

export async function remove (win, tab) {
  win = getTopWindow(win)
  // find
  var tabs = getAll(win)
  var i = tabs.indexOf(tab)
  if (i == -1) {
    return console.warn('tabs/manager remove() called for missing tab', tab)
  }

  // give the 'onbeforeunload' a chance to run
  var onBeforeUnloadReturnValue = await fireBeforeUnloadEvent(tab.webContents)
  if (onBeforeUnloadReturnValue) {
    var choice = dialog.showMessageBoxSync({
      type: 'question',
      buttons: ['Leave', 'Stay'],
      title: 'Do you want to leave this site?',
      message: 'Changes you made may not be saved.',
      defaultId: 0,
      cancelId: 1
    })
    var leave = (choice === 0)
    if (!leave) return
  }

  // save, in case the user wants to restore it
  closedURLs[win.id] = closedURLs[win.id] || []
  closedURLs[win.id].push(tab.url)

  // set new active if that was
  if (tab.isActive && tabs.length > 1) {
    setActive(win, tabs[i + 1] || tabs[i - 1])
  }

  // remove
  tab.stopLiveReloading()
  tabs.splice(i, 1)
  tab.destroy()

  // persist pins w/o this one, if that was
  if (tab.isPinned) savePins(win)

  // close the window if that was the last tab
  if (tabs.length === 0) return win.close()
  emitReplaceState(win)
}

export async function removeAllExcept (win, tab) {
  win = getTopWindow(win)
  var tabs = getAll(win).slice() // .slice() to duplicate the list
  for (let t of tabs) {
    if (t !== tab) {
      await remove(win, t)
    }
  }
}

export async function removeAllToRightOf (win, tab) {
  win = getTopWindow(win)
  var toRemove = []
  var tabs = getAll(win)
  let index = tabs.indexOf(tab)
  for (let i = 0; i < tabs.length; i++) {
    if (i > index) toRemove.push(tabs[i])
  }
  for (let t of toRemove) {
    await remove(win, t)
  }
}

export function setActive (win, tab) {
  win = getTopWindow(win)
  if (typeof tab === 'number') {
    tab = getByIndex(win, tab)
  }
  if (!tab) return

  // deactivate the old tab
  var active = getActive(win)
  if (active) {
    if (active === tab) {
      return
    }
  }

  tab.activate()
  if (active) {
    active.deactivate()
  }
  lastSelectedTabIndex[win.id] = getAll(win).indexOf(active)

  windowMenu.onSetCurrentLocation(win) // give the window-menu a chance to handle the change
  emitReplaceState(win)
}

export function resize (win) {
  var active = getActive(win)
  if (active) active.resize()
}

export function initializeFromSnapshot (win, snapshot) {
  win = getTopWindow(win)
  for (let url of snapshot) {
    create(win, url)
  }
}

export function takeSnapshot (win) {
  win = getTopWindow(win)
  return getAll(win)
    .filter(v => !v.isPinned)
    .map(v => v.url)
    .filter(Boolean)
}

export async function popOutTab (tab) {
  var newWin = createShellWindow()
  await new Promise(r => newWin.once('custom-pages-ready', r))
  transferTabToWindow(tab, newWin)
  removeAllExcept(newWin, tab)
}

export function transferTabToWindow (tab, targetWindow) {
  var sourceWindow = tab.browserWindow

  // find
  var sourceTabs = getAll(sourceWindow)
  var i = sourceTabs.indexOf(tab)
  if (i == -1) {
    return console.warn('tabs/manager transferTabToWindow() called for missing tab', tab)
  }

  // remove
  var shouldCloseSource = false
  sourceTabs.splice(i, 1)
  if (tab.isPinned) savePins(sourceWindow)
  if (sourceTabs.length === 0) {
    shouldCloseSource = true
  } else {
    if (tab.isActive) {
      // setActive(sourceWindow, sourceTabs[i + 1] || sourceTabs[i - 1])
      changeActiveToLast(sourceWindow)
    }
    emitReplaceState(sourceWindow)
  }

  // transfer to the new window
  tab.transferWindow(targetWindow)
  var targetTabs = getAll(targetWindow)
  if (tab.isPinned) {
    targetTabs.splice(indexOfLastPinnedTab(targetWindow), 0, tab)
    savePins(targetWindow)
  } else {
    targetTabs.push(tab)
  }
  emitReplaceState(targetWindow)

  if (shouldCloseSource) {
    sourceWindow.close()
  }
}

export function togglePinned (win, tab) {
  win = getTopWindow(win)
  // move tab to the "end" of the pinned tabs
  var tabs = getAll(win)
  var oldIndex = tabs.indexOf(tab)
  var newIndex = indexOfLastPinnedTab(win)
  if (oldIndex < newIndex) newIndex--
  tabs.splice(oldIndex, 1)
  tabs.splice(newIndex, 0, tab)

  // update tab state
  tab.isPinned = !tab.isPinned
  emitReplaceState(win)

  // persist
  savePins(win)
}

export function savePins (win) {
  win = getTopWindow(win)
  return settingsDb.set('pinned_tabs', JSON.stringify(getAllPinned(win).map(p => p.url)))
}

export async function loadPins (win) {
  win = getTopWindow(win)
  var json = await settingsDb.get('pinned_tabs')
  try { JSON.parse(json).forEach(url => create(win, url, {isPinned: true})) }
  catch (e) {}
}

export function reopenLastRemoved (win) {
  win = getTopWindow(win)
  var url = (closedURLs[win.id] || []).pop()
  if (url) {
    var tab = create(win, url)
    setActive(win, tab)
    return tab
  }
}

export function reorder (win, oldIndex, newIndex) {
  win = getTopWindow(win)
  if (oldIndex === newIndex) {
    return
  }
  var tabs = getAll(win)
  var tab = getByIndex(win, oldIndex)
  tabs.splice(oldIndex, 1)
  tabs.splice(newIndex, 0, tab)
  emitReplaceState(win)
}

export function changeActiveBy (win, offset) {
  win = getTopWindow(win)
  var tabs = getAll(win)
  var active = getActive(win)
  if (tabs.length > 1) {
    var i = tabs.indexOf(active)
    if (i === -1) { return console.warn('Active page is not in the pages list! THIS SHOULD NOT HAPPEN!') }

    i += offset
    if (i < 0) i = tabs.length - 1
    if (i >= tabs.length) i = 0

    setActive(win, tabs[i])
  }
}

export function changeActiveTo (win, index) {
  win = getTopWindow(win)
  var tabs = getAll(win)
  if (index >= 0 && index < tabs.length) {
    setActive(win, tabs[index])
  }
}

export function changeActiveToLast (win) {
  win = getTopWindow(win)
  var tabs = getAll(win)
  setActive(win, tabs[tabs.length - 1])
}

export function getPreviousTabIndex (win) {
  var index = lastSelectedTabIndex[win.id]
  if (typeof index !== 'number') return 0
  if (index < 0 || index >= getAll(win).length) return 0
  return index
}

export function openOrFocusDownloadsPage (win) {
  win = getTopWindow(win)
  var tabs = getAll(win)
  var downloadsTab = tabs.find(v => v.url.startsWith('beaker://library/downloads'))
  if (!downloadsTab) {
    downloadsTab = create(win, 'beaker://library/downloads')
  }
  setActive(win, downloadsTab)
}

export function emitReplaceStateAllWindows () {
  for (let win of BrowserWindow.getAllWindows()) {
    emitReplaceState(win)
  }
}

export function emitReplaceState (win) {
  win = getTopWindow(win)
  var state = {
    tabs: getWindowTabState(win),
    isFullscreen: win.isFullScreen(),
    isShellInterfaceHidden: getAddedWindowSettings(win).isShellInterfaceHidden,
    isDaemonActive: hyper.daemon.isActive()
  }
  emit(win, 'replace-state', state)
  win.emit('custom-pages-updated', takeSnapshot(win))
}

// rpc api
// =

rpc.exportAPI('background-process-views', viewsRPCManifest, {
  createEventStream () {
    return emitStream(getEvents(getWindow(this.sender)))
  },

  async refreshState (tab) {
    var win = getWindow(this.sender)
    tab = getByIndex(win, tab)
    if (tab) {
      tab.refreshState()
    }
  },

  async getState () {
    var win = getWindow(this.sender)
    return getWindowTabState(win)
  },

  async getTabState (tab, opts) {
    var win = getWindow(this.sender)
    tab = getByIndex(win, tab)
    if (tab) {
      var state = Object.assign({}, tab.state)
      if (opts) {
        if (opts.driveInfo) state.driveInfo = tab.driveInfo
        if (opts.sitePerms) state.sitePerms = await sitedataDb.getPermissions(tab.url)
      }
      return state
    }
  },

  async getNetworkState (tab, opts) {
    var win = getWindow(this.sender)
    tab = getByIndex(win, tab)
    if (tab && tab.driveInfo) {
      let peers = await hyper.daemon.getPeerCount(Buffer.from(tab.driveInfo.key, 'hex'))
      let peerAddresses = undefined
      if (opts && opts.includeAddresses) {
        peerAddresses = await hyper.daemon.listPeerAddresses(tab.driveInfo.discoveryKey)
      }
      return {peers, peerAddresses}
    }
  },

  async getBackgroundTabs () {
    return backgroundTabs.map(tab => ({
      url: tab.url,
      title: tab.title
    }))
  },

  async createTab (url, opts = {focusLocationBar: false, setActive: false}) {
    var win = getWindow(this.sender)
    var tab = create(win, url, opts)
    return getAll(win).indexOf(tab)
  },

  async loadURL (index, url) {
    if (url === '$new_tab') {
      url = defaultUrl
    }
    getByIndex(getWindow(this.sender), index).loadURL(url)
  },

  async minimizeTab (index) {
    var win = getWindow(this.sender)
    minimizeToBg(win, getByIndex(win, index))
  },

  async closeTab (index) {
    var win = getWindow(this.sender)
    remove(win, getByIndex(win, index))
  },

  async setActiveTab (index) {
    var win = getWindow(this.sender)
    setActive(win, getByIndex(win, index))
  },

  async reorderTab (oldIndex, newIndex) {
    var win = getWindow(this.sender)
    reorder(win, oldIndex, newIndex)
  },

  restoreBgTab (index) {
    if (!backgroundTabs[index]) return
    var win = getWindow(this.sender)
    restoreBgTabByIndex(win, index)
  },

  closeBgTab (index) {
    if (!backgroundTabs[index]) return
    backgroundTabs[index].destroy()
    backgroundTabs.splice(index, 1)
  },

  async showTabContextMenu (index) {
    var win = getWindow(this.sender)
    var tab = getByIndex(win, index)
    var menu = Menu.buildFromTemplate([
      { label: (tab.isPinned) ? 'Unpin Tab' : 'Pin Tab', click: () => togglePinned(win, tab) },
      { label: 'Pop Out Tab', click: () => popOutTab(tab) },
      { label: 'Duplicate Tab', click: () => create(win, tab.url, {adjacentActive: true}) },
      { label: (tab.isAudioMuted) ? 'Unmute Tab' : 'Mute Tab', click: () => tab.toggleMuted() },
      { label: 'Minimize to Background', click: () => minimizeToBg(win, tab) },
      { type: 'separator' },
      { label: 'Close Tab', click: () => remove(win, tab) },
      { label: 'Close Other Tabs', click: () => removeAllExcept(win, tab) },
      { label: 'Close Tabs to the Right', click: () => removeAllToRightOf(win, tab) },
      { type: 'separator' },
      { label: 'New Tab', click: () => create(win, null, {setActive: true}) },
      { label: 'Reopen Closed Tab', click: () => reopenLastRemoved(win) }
    ])
    menu.popup()
  },

  async showLocationBarContextMenu (index) {
    var win = getWindow(this.sender)
    var tab = getByIndex(win, index)
    var clipboardContent = clipboard.readText()
    var clipInfo = examineLocationInput(clipboardContent)
    var menu = Menu.buildFromTemplate([
      { label: 'Cut', role: 'cut' },
      { label: 'Copy', role: 'copy' },
      { label: 'Paste', role: 'paste' },
      { label: `Paste and ${clipInfo.isProbablyUrl ? 'Go' : 'Search'}`, click: onPasteAndGo }
    ])
    menu.popup({window: win})

    function onPasteAndGo () {
      // close the menu
      shellMenus.hide(win)
      win.webContents.send('command', 'unfocus-location')

      // load the URL
      var url = clipInfo.isProbablyUrl ? clipInfo.vWithProtocol : clipInfo.vSearch
      tab.loadURL(url)
    }
  },

  async goBack (index) {
    getByIndex(getWindow(this.sender), index).webContents.goBack()
  },

  async goForward (index) {
    getByIndex(getWindow(this.sender), index).webContents.goForward()
  },

  async stop (index) {
    getByIndex(getWindow(this.sender), index).webContents.stop()
  },

  async reload (index) {
    getByIndex(getWindow(this.sender), index).webContents.reload()
  },

  async resetZoom (index) {
    zoom.zoomReset(getByIndex(getWindow(this.sender), index))
  },

  async toggleLiveReloading (index, enabled) {
    getByIndex(getWindow(this.sender), index).toggleLiveReloading(enabled)
  },

  async toggleDevTools (index) {
    getByIndex(getWindow(this.sender), index).webContents.toggleDevTools()
  },

  async print (index) {
    getByIndex(getWindow(this.sender), index).webContents.print()
  },

  async showInpageFind (index) {
    getByIndex(getWindow(this.sender), index).showInpageFind()
  },

  async hideInpageFind (index) {
    getByIndex(getWindow(this.sender), index).hideInpageFind()
  },

  async setInpageFindString (index, str, dir) {
    getByIndex(getWindow(this.sender), index).setInpageFindString(str, dir)
  },

  async moveInpageFind (index, dir) {
    getByIndex(getWindow(this.sender), index).moveInpageFind(dir)
  },

  async showLocationBar (opts) {
    await locationBar.show(getWindow(this.sender), opts)
  },

  async hideLocationBar () {
    await locationBar.hide(getWindow(this.sender))
  },

  async runLocationBarCmd (cmd, opts) {
    return locationBar.runCmd(getWindow(this.sender), cmd, opts)
  },

  async showMenu (id, opts) {
    await shellMenus.show(getWindow(this.sender), id, opts)
  },

  async toggleMenu (id, opts) {
    await shellMenus.toggle(getWindow(this.sender), id, opts)
  },

  async updateMenu (opts) {
    await shellMenus.update(getWindow(this.sender), opts)
  },

  async toggleSiteInfo (opts) {
    await siteInfo.toggle(getWindow(this.sender), opts)
  },

  async focusShellWindow () {
    getWindow(this.sender).webContents.focus()
  },

  async focusPage () {
    getActive(this.sender).focus()
  }
})

// internal methods
// =

function emitUpdateState (tab) {
  var win = getTopWindow(tab.browserWindow)
  var index = typeof tab === 'number' ? tab : getAll(win).indexOf(tab)
  if (index === -1) {
    console.warn('WARNING: attempted to update state of a tab not on the window')
    return
  }
  emit(win, 'update-state', {index, state: tab.state})
  win.emit('custom-pages-updated', takeSnapshot(win))
}

function getWindow (sender) {
  return findWebContentsParentWindow(sender)
}

// helper ensures that if a subwindow is called, we use the parent
function getTopWindow (win) {
  if (!(win instanceof BrowserWindow)) {
    return findWebContentsParentWindow(win)
  }
  while (win.getParentWindow()) {
    win = win.getParentWindow()
  }
  return win
}

function getEvents (win) {
  if (!(win.id in windowEvents)) {
    windowEvents[win.id] = new EventEmitter()
  }
  return windowEvents[win.id]
}

function emit (win, ...args) {
  getEvents(win).emit(...args)
}

function getWindowTabState (win) {
  return getAll(win).map(tab => tab.state)
}

function indexOfLastPinnedTab (win) {
  var tabs = getAll(win)
  var index = 0
  for (index; index < tabs.length; index++) {
    if (!tabs[index].isPinned) break
  }
  return index
}

function defineActivePanePassthroughGetter (obj, name) {
  Object.defineProperty(obj, name, {
    enumerable: true,
    get () {
      return obj.activePane[name]
    }
  })
}

function defineActivePanePassthroughFn (obj, name) {
  obj[name] = (function (...args) {
    if (!this.activePane) {
      throw new Error('No active pane')
    }
    return this.activePane[name](...args)
  }).bind(obj)
}

async function fireBeforeUnloadEvent (wc) {
  try {
    if (wc.isLoading() || wc.isWaitingForResponse()) {
      return // dont bother
    }
    return await Promise.race([
      wc.executeJavaScript(`
        (function () {
          let unloadEvent = new Event('beforeunload', {bubbles: false, cancelable: true})
          unloadEvent.returnValue = false
          return window.dispatchEvent(unloadEvent)
        })()
      `),
      new Promise(r => {
        setTimeout(r, 500) // thread may be locked, so abort after 500ms
      })
    ])
    } catch (e) {
      // ignore
    }
}

/**
 * NOTE
 * preloading a tab generates a slight performance cost which was interrupting the UI
 * (it manifested as a noticeable delay in the location bar)
 * by delaying before creating the preloaded tab, we avoid overloading any threads
 * and disguise the performance overhead
 * -prf
 */
var _createPreloadedNewTabTOs = {} // map of {[win.id] => timeout}
function createPreloadedNewTab (win) {
  var id = win.id
  if (_createPreloadedNewTabTOs[id]) {
    clearTimeout(_createPreloadedNewTabTOs[id])
  }
  _createPreloadedNewTabTOs[id] = setTimeout(() => {
    _createPreloadedNewTabTOs[id] = null
    preloadedNewTabs[id] = new Tab(win, {isHidden: true})
    preloadedNewTabs[id].loadURL(defaultUrl)
  }, 1e3)
}