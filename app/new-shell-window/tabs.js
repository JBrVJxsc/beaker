import {LitElement, html, css} from './lit-element/lit-element'
import {classMap} from './lit-element/lit-html/directives/class-map'
import {repeat} from './lit-element/lit-html/directives/repeat'
import spinnerCSS from './spinner.css'
import * as bg from './bg-process-rpc'

class ShellWindowTabs extends LitElement {
  static get properties () {
    return {
      tabs: {type: Array}
    }
  }

  constructor () {
    super()
    this.tabs = []

    bg.views.createEventStream().on('data', evt => {
      switch (evt[0]) {
        case 'replace-state':
          console.log('repalce-state', evt[1])
          this.tabs = evt[1]
          this.requestUpdate()
          break
        case 'update-state':
          console.log('update-state', evt[1])
          Object.assign(this.tabs[evt[1].index], evt[1].state)
          this.requestUpdate()
          break
      }
    })

    bg.views.getState().then(state => {
      console.log('got state', state)
      this.tabs = state
      this.requestUpdate()
    })
  }

  render () {
    return html`
      <div class="shell ${window.platform}">
        <div class="tabs">
          ${repeat(this.tabs, (tab, index) => this.renderTab(tab, index))}
          <div
            class="unused-space"
            @dragover=${e => this.onDragoverTab(e, -1)}
            @dragleave=${e => this.onDragleaveTab(e, -1)}
            @drop=${e => this.onDropTab(e, -1)}
          >
            <div class="tab tab-add-btn" @click=${this.onClickNew} title="Open new tab">
              <span class="plus">+</span>
            </div>
          </div>
        </div>
      </div>
    `
  }

  renderTab (tab, index) {
    const cls = classMap({tab: true, current: tab.isActive})
    return html`
      <div
        class="${cls}"
        draggable="true"
        @click=${e => this.onClickTab(e, index)}
        @dragstart=${e => this.onDragstartTab(e, index)}
        @dragend=${e => this.onDragendTab(e, index)}
        @dragover=${e => this.onDragoverTab(e, index)}
        @dragleave=${e => this.onDragleaveTab(e, index)}
        @drop=${e => this.onDropTab(e, index)}
      >
        <div class="tab-favicon">
          ${tab.isLoading
            ? tab.isReceivingAssets
              ? html`<div class="spinner"></div>`
              : html`<div class="spinner reverse"></div>`
            : html`<img src="beaker-favicon:${tab.url}?cache=${Date.now()}">`}
        </div>
        <div class="tab-title">${tab.title}</div>
        <div class="tab-close" title="Close tab"></div>
      </div>
    `
  }

  // events
  // =

  async onClickNew (e) {
    var index = await bg.views.createTab()
    bg.views.setActiveTab(index)
  }

  onClickTab (e, index) {
    bg.views.setActiveTab(index)
  }

  onDragstartTab (e, index) {
    e.dataTransfer.effectAllowed = 'move'
  }
  
  onDragendTab (e, index) {
    // TODO needed?
  }

  onDragoverTab (e, index) {
    e.preventDefault()
    e.currentTarget.classList.add('drag-hover')

    e.dataTransfer.dropEffect = 'move'
    return false
  }

  onDragleaveTab (e, index) {
    e.currentTarget.classList.remove('drag-hover')
  }

  onDropTab (e, index) {
    e.stopPropagation()
    e.currentTarget.classList.remove('drag-hover')

    if (index) {
      bg.views.reorderTab(this.draggedTabIndex, index)
    }
    return false
  }
}
ShellWindowTabs.styles = css`
${spinnerCSS}

.shell {
  position: relative;
  padding: 0 18px 0 0px;
  height: 36px;
  border-bottom: 1px solid var(--color-border);
}

.tabs {
  display: flex;
  padding-left: 10px;
  height: 36px;
}

.unused-space {
  flex: 1;
  position: relative;
  top: 6px;
  height: 30px;
}

.drag-hover:before {
  content: '';
  position: absolute;
  left: -4px;
  top: -3px;
  height: 0;
  width: 0px;
  border-top: 8px solid red;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
}

.tabs * {
  -webkit-user-select: none;
  cursor: default;
  font-size: 12px;
  line-height: 13px;
}

.tab {
  display: inline-block;
  position: relative;
  top: 6px;
  height: 30px;
  width: 235px;
  -webkit-app-region: no-drag;
  border: 1px solid transparent;
}

.tab-favicon {
  width: 16px;
  height: 23px;
  text-align: center;
  position: absolute;
  left: 10px;
  top: 8px;
  z-index: 3;
}

.tab-favicon img {
  width: 16px;
  height: 16px;
}

.tab-favicon .spinner {
  position: relative;
  left: 1px;
  top: 1px;
  width: 10px;
  height: 10px;
}

.tab-pinned .tab-favicon {
  left: 16px;
}

.tab-title {
  color: var(--color-tab);
  padding: 9px 11px 5px 30px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-left: 1px solid var(--color-border);
}

.tab:first-child .tab-title,
.tab.current .tab-title,
.tab.current + .tab .tab-title {
  border-left-color: transparent;
}

.fa-volume-up,
.fa-volume-mute {
  margin-right: 4px;
}

.tab-nofavicon .tab-title {
  padding-left: 16px;
}

.tab-close {
  display: none;
  position: absolute;
  right: 8px;
  top: 7px;
  width: 16px;
  height: 16px;
  z-index: 2;
  border-radius: 2px;
  text-align: center;
  color: var(--color-tab-close);
}

.tab-close:before {
  display: block;
  content: "\\00D7";
  font-size: 20px;
  font-weight: 200;
  opacity: 0;
  line-height: .71;
}

.tab-close:hover:before,
.tab-close:active:before {
  opacity: 1;
}

.tab-close:hover,
.tab-close:active {
  background: var(--bg-tab-close--hover);
}

.tab.tab-add-btn {
  top: 0;
  width: 36px;
}

.tab-add-btn .plus {
  position: absolute;
  top: 0;
  display: block;
  font-size: 19px;
  font-weight: 300;
  color: var(--color-tab-add);
  margin: 4px 7px;
  width: 22px;
  height: 21px;
  text-align: center;
  line-height: 100%;
  border-radius: 2px;
}

.tab.tab-add-btn:hover {
  background: inherit;
}

.tab-add-btn:hover .tab-close:before {
  opacity: 1;
}

.tab-add-btn:hover .plus {
  background: var(--bg-tab-add--hover);
  color: var(--color-tab-add--hover);
}

.tab:not(.current):hover .tab-title {
  background: var(--bg-tab--hover);
}

/* add a gradient effect */
.tab:not(.current):hover .tab-title:after {
  content: '';
  display: block;
  position: absolute;
  right: 0;
  top: 0;
  height: 27px;
  width: 60px;
  background: linear-gradient(to right, rgba(226,226,226,0), rgb(226, 226, 226));
}

.tab:hover .tab-close {
  display: block;
  background: var(--bg-tab--hover);
}

.tab:hover .tab-close:hover {
  background: var(--bg-tab-close--hover);
}

.tab:hover .tab-close:before {
  opacity: 1;
}

.tab.current {
  background: var(--bg-tab--current);
  border: 1px solid var(--color-border);
  border-bottom: 0;
  border-radius: 3px 3px 0 0;
}

.tab.current .tab-favicon {
  top: 8px;
}

.tab.current .tab-title {
  padding-top: 9px;
}

.tab.current .tab-title:after {
  /* adjust color */
  background: linear-gradient(to right, rgba(247,247,247,0), rgb(247, 247, 247));
}

.tab.current .tab-close {
  background: var(--bg-tab--current);
}

/* draggable region for OSX and windows */
.win32 .tabs,
.darwin .tabs {
  -webkit-app-region: drag;
}

/* make room for resizing on the top */
.win32.shell {
  padding-top: 4px;
}
.win32 .tabs {
  height: 32px;
} 
.win32 .tab {
  top: 2px;
}

/* make room for traffic lights */
.darwin .tabs {
  padding-left: 75px;
}
`
customElements.define('shell-window-tabs', ShellWindowTabs)
