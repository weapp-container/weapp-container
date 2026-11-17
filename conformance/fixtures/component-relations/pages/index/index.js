const PARENT_KEY = '../child/index'
const CHILD_KEY = '../parent/index'

function currentPage() {
  const pages = getCurrentPages()
  return pages[pages.length - 1]
}

Page({
  data: { showChild: true },
  removeChild() { this.setData({ showChild: false }) },
  restoreChild() { this.setData({ showChild: true }) },
  onLoad() {
    const app = getApp()
    app.trace.push('page:onLoad')
    app.heldParent = this.selectComponent('#relation-parent')
    app.heldChild = this.selectComponent('#relation-child')
  },
})

exports.inspect = function() {
  const page = currentPage()
  const app = getApp()
  const parent = page.selectComponent('#relation-parent')
  const child = page.selectComponent('#relation-child')
  const parentNodes = parent.getRelationNodes(PARENT_KEY)
  const secondRead = parent.getRelationNodes(PARENT_KEY)
  const parentNode = parentNodes[0]
  const childNodes = child ? child.getRelationNodes(CHILD_KEY) : []
  const beforeMutation = parentNodes.length
  parentNodes.length = 0
  const relationArrayIsIsolated = parent.getRelationNodes(PARENT_KEY).length === beforeMutation
  return {
    launched: app.launched,
    capabilities: {
      relations: wx.canIUse('Component.relations'),
      getRelationNodes: wx.canIUse('Component.getRelationNodes'),
    },
    trace: app.trace.slice(),
    showChild: page.data.showChild,
    parentSurvives: parent === app.heldParent,
    childPresent: Boolean(child),
    childIsInitial: child === app.heldChild,
    parentNodes: secondRead.map(node => node.data.label),
    childNodes: childNodes.map(node => node.data.label),
    parentRelationUsesLiveChild: Boolean(child) && parentNode === child,
    childRelationUsesLiveParent: Boolean(child) && childNodes[0] === parent,
    relationArrayIsFresh: parentNodes !== secondRead,
    relationArrayIsIsolated,
    heldChildRelations: app.heldChild.getRelationNodes(CHILD_KEY).map(node => node.data.label),
    childCount: child ? child.data.count : null,
    childColor: child ? child.data.color : null,
    heldChildCount: app.heldChild.data.count,
    childGenerations: app.children.length,
    initialChildTracked: app.children[0] === app.heldChild,
    currentChildTracked: !child || child === app.children[app.children.length - 1],
    restoredChildIsFresh: app.children.length < 2 || app.children[0] !== app.children[1],
    callbacks: app.callbacks.map(record => ({
      label: record.label,
      event: record.event,
      childGeneration: record.childGeneration,
      sourceIsLiveReference: record.instance === (record.label === 'parent' ? app.heldParent : app.children[record.childGeneration]),
      targetIsLiveReference: record.target === (record.label === 'parent' ? app.children[record.childGeneration] : app.heldParent),
      targetLabel: record.target.data.label,
    })),
  }
}

exports.bumpHeldChild = function() {
  const app = getApp()
  const parent = app.heldParent
  const related = parent.getRelationNodes(PARENT_KEY)[0]
  related.bump()
  return {
    count: related.data.count,
    sameHeldReference: related === app.heldChild,
    selectedSeesSameState: currentPage().selectComponent('#relation-child').data.count === related.data.count,
  }
}

exports.remove = function() { currentPage().removeChild(); return true }
exports.restore = function() { currentPage().restoreChild(); return true }
