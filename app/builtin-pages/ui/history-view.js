/*
This uses the beaker.history API, which is exposed by webview-preload to all sites loaded over the beaker: protocol
*/

import * as yo from 'yo-yo'
import * as moment from 'moment'

// globals
// =

// how many px from bottom till more is loaded?
const BEGIN_LOAD_OFFSET = 100

// visits, cached in memory
var visits = []
var isAtEnd = false

// exported API
// =

export function setup () {
}

export function show () {
  fetchMore(render)
}

export function hide () {
}

// data
// =

var isFetching = false
function fetchMore (cb) {
  if (isFetching)
    return

  if (isAtEnd)
    return cb()

  isFetching = true
  beaker.history.getVisitHistory({ offset: visits.length, limit: 50 }, (err, rows) => {
    visits = visits.concat(rows || [])
    isFetching = false
    cb()
  })
}

// rendering
// =

function render () {
  var rowEls = []
  var lastDate = moment().startOf('day').add(1, 'day')
  const endOfToday = moment().endOf('day')

  visits.forEach((row, i) => {
    // render a date heading if this post is from a different day than the last
    var oldLastDate = lastDate
    lastDate = moment(row.ts).endOf('day')
    if (!lastDate.isSame(oldLastDate, 'day')) {
      var label
      if (lastDate.isSame(endOfToday, 'day'))
        label = 'today'      
      else if (lastDate.isSame(endOfToday.subtract(1, 'day'), 'day'))
        label = 'yesterday'
      else if (lastDate.isSame(endOfToday, 'month'))
        label = lastDate.from(endOfToday)
      else if (lastDate.isSame(endOfToday, 'year'))
        label = lastDate.format("dddd, MMMM Do")
      else
        label = lastDate.format("MMMM Do YYYY")
      rowEls.push(yo`<div class="ll-heading">${label}</div>`)
    }

    // render row
    rowEls.push(yo`<div class="ll-row">
      <a class="ll-link" href=${row.url} title=${row.title}>
        <span class="icon icon-window"></span>
        <span class="ll-title">${row.title}</span>
      </div>
      <div class="ll-actions">
        <span class="icon icon-cancel-squared" onclick=${onClickDelete.bind(window, i)} title="Remove from history"></span>
      </div>
    </div>`)
  })

  yo.update(document.querySelector('#el-content'), yo`<div class="pane" id="el-content" onscroll=${onScrollContent}>
    <div class="history links-list">${rowEls}</div>
  </div>`)
}

// event handlers
// =

function onScrollContent (e) {
  if (isAtEnd)
    return

  var el = e.target
  if (el.offsetHeight + el.scrollTop + BEGIN_LOAD_OFFSET >= el.scrollHeight) {
    // hit bottom
    fetchMore(render)
  }
}

function onClickDelete (i) {
  // remove
  var v = visits[i]
  visits.splice(i, 1)
  beaker.history.removeVisit(v.url)
  render()
}