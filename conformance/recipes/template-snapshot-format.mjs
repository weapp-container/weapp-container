/** Generated only from the pinned unchanged helper spans. See original-helper-spans.json. */
import {DomUtils,parseDocument} from './template-format-dependencies/htmlparser2/dist/index.js';
import postcss from './template-format-dependencies/postcss/lib/postcss.js';
function normalizeMarkupNode(node            ) {
  if ('attribs' in node && node.attribs.style && !node.attribs.style.includes('{{')) {
    const style = postcss.parse(`view {${node.attribs.style}}`).first
    if (style?.type === 'rule') {
      node.attribs.style = style.nodes.map(child => child.type === 'decl'
        ? `${child.prop}: ${child.value}${child.important ? ' !important' : ''}`
        : child.toString()).join('; ')
    }
  }
  if ('children' in node) {
    for (const child of node.children) {
      normalizeMarkupNode(child)
    }
  }
}

function canonicalWxml(source        ) {
  const document = parseDocument(source, {
    xmlMode: true,
    decodeEntities: false,
    lowerCaseAttributeNames: false,
    lowerCaseTags: false,
  })
  for (const child of document.children) {
    normalizeMarkupNode(child)
  }
  return DomUtils.getOuterHTML(document, { xmlMode: true, decodeEntities: false })
}

function canonicalWxss(source        ) {
  const root = postcss.parse(source)
  root.raws = { after: '\n' }
  root.walk((node) => {
    node.raws = {}
    if (node.type === 'decl') {
      node.raws.between = node.value.trim() ? ': ' : ':'
    }
    if ('nodes' in node) {
      node.raws.semicolon = true
    }
  })
  return `${root.toString().trim()}\n`
}

const AUTOMATOR_OVERLAY_RE = /\s*\.luna-dom-highlighter[\s\S]*$/

const TAP_ATTR_RE = /\s+(?:@tap|bind:tap|bindtap)=["'][^"']*["']/g

const UNSUPPORTED_VUE_EVENT_SHORTHAND_RE = /\s@[a-z][\w:-]*(?:\.[\w-]+)*=/i

const PHONE_NUMBER_NO_QUOTA_TOAST_ATTR_RE = /\s+phone-number-no-quota-toast=""/g

const INVALID_INPUT_RE = /<input\b([^>]*)>([\s\S]*?)<\/input>/gi

const LEADING_SLASH_RE = /^\/+/

const TRAILING_SLASH_RE = /\/+$/

const CSS_DECLARATION_START_RE = /^(\s*)([a-z-]+):(?:\s.*)?$/

const LEGACY_PSEUDO_ELEMENT_RE = /(^|[^:]):(before|after)\b/g

const ZERO_UNIT_RE = /(^|[^\w.-])0(?:px|rpx|rem|em|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pt|pc|q|%)\b/g

const SECOND_TIME_RE = /(^|[\s,(])(\d+\.\d+|\d+|\.\d+)s(?=($|[\s),]))/g

const MS_TIME_RE = /(^|[\s,(])(\d+\.\d+|\d+|\.\d+)ms(?=($|[\s),]))/g

const RGBA_RE = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([+-]?(\d+\.\d+|\d+|\.\d+)))?\s*\)/gi

const VITE_MARKER_COMMENT_RE = /^\$vite\$:\d+$/

const SCOPED_SLOT_ID_RE = /\bscoped-slot-[a-z0-9]+-default-\d+\b/g

async function formatWxml(wxml        ) {
  return canonicalWxml(wxml)
}

function normalizeButtonCompatAttrs(wxml        ) {
  return wxml.replace(/<button\b([^>]*)>/g, (_fullMatch, attrsRaw        ) => {
    const attrs = attrsRaw ?? ''
    const normalizedAttrs = attrs.trim()
    const attrMap = new Map                ()
    const attrOrder           = []

    for (const match of normalizedAttrs.matchAll(/([:@\w-]+)\s*=\s*(".*?"|'.*?')/g)) {
      const name = match[1]
      const value = match[2]
      if (!name || !value) {
        continue
      }
      if (!attrMap.has(name)) {
        attrOrder.push(name)
      }
      attrMap.set(name, value)
    }

    const ensureAttr = (name        , value        ) => {
      if (attrMap.has(name)) {
        return
      }
      attrMap.set(name, value)
    }

    ensureAttr('activity-type', '"0"')
    ensureAttr('entrance-path', '""')
    ensureAttr('need-show-entrance', '""')

    const fixedPrefix = ['activity-type', 'entrance-path', 'need-show-entrance', 'app-parameter']
    const renderedNames = new Set        ()
    const renderedAttrs           = []

    for (const name of fixedPrefix) {
      const value = attrMap.get(name)
      if (!value) {
        continue
      }
      renderedNames.add(name)
      renderedAttrs.push(`${name}=${value}`)
    }

    for (const name of attrOrder) {
      if (renderedNames.has(name)) {
        continue
      }
      const value = attrMap.get(name)
      if (!value) {
        continue
      }
      renderedNames.add(name)
      renderedAttrs.push(`${name}=${value}`)
    }

    for (const [name, value] of attrMap.entries()) {
      if (renderedNames.has(name)) {
        continue
      }
      renderedNames.add(name)
      renderedAttrs.push(`${name}=${value}`)
    }

    const merged = renderedAttrs.join(' ')
    return `<button ${merged}>`
  })
}

function stripAutomatorOverlay(wxml        ) {
  // Strip devtools overlay styles appended by automator.
  return wxml.replace(AUTOMATOR_OVERLAY_RE, '')
}

function normalizeWxmlForSnapshot(wxml        ) {
  const cleaned = normalizeButtonCompatAttrs(stripAutomatorOverlay(wxml))
    .replace(TAP_ATTR_RE, '')
    .replace(PHONE_NUMBER_NO_QUOTA_TOAST_ATTR_RE, '')
    // Normalize invalid void-element markup from devtools.
    .replace(INVALID_INPUT_RE, '<input$1 />$2')

  const normalizedTabs = cleaned
    // Normalize dynamic hashes in tdesign ids/aria attributes.
    .replace(/id="([0-9a-f]{8})--t-action-sheet"/g, 'id="t-action-sheet--stable"')
    .replace(/aria-describedby="([0-9a-f]{8})--true"/g, 'aria-describedby="t-input-desc--stable"')
    .replace(/aria-describedby="([0-9a-f]{8})--t_badge_(\d+)_description"/g, (_match, _id, index) => (
      `aria-describedby="t_badge_${index}_description"`
    ))
    .replace(/aria-labelledby="([0-9a-f]{8})--t_badge_(\d+)_label"/g, (_match, _id, index) => (
      `aria-labelledby="t_badge_${index}_label"`
    ))
    .replace(/id="([0-9a-f]{8})--t_badge_(\d+)_label"/g, (_match, _id, index) => (
      `id="t_badge_${index}_label"`
    ))
    .replace(/id="([0-9a-f]{8})--t_badge_(\d+)_description"/g, (_match, _id, index) => (
      `id="t_badge_${index}_description"`
    ))
    .replace(/aria-controls="([0-9a-f]{8})--t_tabs_(?!0)(\d+)_panel_(\d+)"/g, (_match, _id, group, index) => (
      `aria-controls="t_tabs_${group}_panel_${index}"`
    ))
    .replace(/id="([0-9a-f]{8})--t_tabs_(?!0)(\d+)_panel_(\d+)"/g, (_match, _id, group, index) => (
      `id="t_tabs_${group}_panel_${index}"`
    ))
    // Normalize tdesign tabs aria-controls ids.
    .replace(/aria-controls="([0-9a-f]{8})--t_tabs_0_panel_(\d+)"/g, (_match, _id, index) => (
      `aria-controls="c9814c17--t_tabs_0_panel_${index}"`
    ))
    // Normalize tdesign tabs panel ids.
    .replace(/id="([0-9a-f]{8})--t_tabs_0_panel_(\d+)"/g, (_match, _id, index        ) => {
      const mapped                         = {
        0: '723fc055',
        1: '1b31d0d4',
        2: '063b76de',
      }
      return mapped[index] ? `id="${mapped[index]}--t_tabs_0_panel_${index}"` : `id="c9814c17--t_tabs_0_panel_${index}"`
    })
    // Normalize scoped id hash prefixes generated for user-defined ids in components.
    .replace(/id="([0-9a-f]{8})--(?!t_)([^"]+)"/g, (_match, _id, suffix) => (
      `id="${suffix}"`
    ))
    // Normalize generated scoped slot ids whose hash depends on compile order.
    .replace(SCOPED_SLOT_ID_RE, 'scoped-slot-stable-default-0')
    // Normalize tabs track translateX variations.
    .replace(/translateX\([\d.]+px\)/g, 'translateX(187px)')

  return normalizedTabs
}

function normalizeCssSelector(selector        ) {
  return selector
    .split(',')
    .map(segment => segment.trim().replace(LEGACY_PSEUDO_ELEMENT_RE, '$1::$2'))
    .join(',\n')
}

function clampCssChannel(value        ) {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(255, Math.max(0, Math.round(value)))
}

function clampCssAlpha(value        ) {
  if (!Number.isFinite(value)) {
    return Number.NaN
  }
  return Math.min(1, Math.max(0, value))
}

function toHex(value        ) {
  return value.toString(16).padStart(2, '0')
}

function stripTrailingZeros(value        ) {
  const normalized = `${value}`
  if (!normalized.includes('.')) {
    return normalized
  }
  return normalized.replace(/0+$/, '').replace(/\.$/, '')
}

function normalizeCssColorFunctions(value        ) {
  return value.replace(RGBA_RE, (match, rawR        , rawG        , rawB        , rawAlpha         ) => {
    const red = clampCssChannel(Number(rawR))
    const green = clampCssChannel(Number(rawG))
    const blue = clampCssChannel(Number(rawB))

    if (rawAlpha == null) {
      return match
    }

    const alpha = clampCssAlpha(Number(rawAlpha))
    if (!Number.isFinite(alpha)) {
      return match
    }
    if (alpha === 0) {
      return 'transparent'
    }

    const alphaByte = Math.round(alpha * 255)
    if (alphaByte === 255) {
      return `#${toHex(red)}${toHex(green)}${toHex(blue)}`
    }

    return `#${toHex(red)}${toHex(green)}${toHex(blue)}${toHex(alphaByte)}`
  })
}

function normalizeCssValue(value        ) {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  return normalizeCssColorFunctions(
    trimmed
      .replace(SECOND_TIME_RE, (_match, prefix        , rawValue        ) => {
        const parsed = Number(rawValue)
        if (!Number.isFinite(parsed)) {
          return `${prefix}${rawValue}s`
        }
        return `${prefix}${stripTrailingZeros(parsed * 1000)}ms`
      })
      .replace(MS_TIME_RE, (_match, prefix        , rawValue        ) => {
        const parsed = Number(rawValue)
        if (!Number.isFinite(parsed)) {
          return `${prefix}${rawValue}ms`
        }
        return `${prefix}${stripTrailingZeros(parsed)}ms`
      })
      .replace(ZERO_UNIT_RE, '$10')
      .replace(/\btransparent\b/gi, 'transparent'),
  )
}

function sortRuleDeclarations(rule      ) {
  const nodes = rule.nodes ?? []
  if (nodes.length < 2 || nodes.some(node => node.type !== 'decl')) {
    return
  }

  const declarations = nodes                 
  const propSet = new Set        ()
  for (const declaration of declarations) {
    if (propSet.has(declaration.prop)) {
      return
    }
    propSet.add(declaration.prop)
  }

  const sorted = [...declarations].sort((left, right) => {
    const propCompare = left.prop.localeCompare(right.prop)
    if (propCompare !== 0) {
      return propCompare
    }
    return left.value.localeCompare(right.value)
  })

  rule.removeAll()
  for (const declaration of sorted) {
    rule.append(declaration)
  }
}

function normalizeWxssForSnapshot(wxss        ) {
  const lines = wxss.split('\n')
  const normalized           = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] 
    const declarationMatch = CSS_DECLARATION_START_RE.exec(line)
    if (!declarationMatch || line.trimStart().startsWith('@')) {
      normalized.push(line)
      continue
    }

    const block = [line]
    while (index + 1 < lines.length && !block.at(-1)?.trimEnd().endsWith(';')) {
      index += 1
      block.push(lines[index] )
    }

    const property = declarationMatch[2]
    const previousStart = normalized.at(-1)
    const previousMatch = previousStart
      ? CSS_DECLARATION_START_RE.exec(previousStart)
      : null

    if (previousMatch?.[1] === declarationMatch[1] && previousMatch[2] === property) {
      while (normalized.length > 0) {
        const current = normalized.pop()
        if (current?.trimEnd().endsWith(';')) {
          break
        }
      }
    }

    normalized.push(...block)
  }

  const ast = postcss.parse(normalized.join('\n'))

  ast.walkComments((comment) => {
    if (VITE_MARKER_COMMENT_RE.test(comment.text.trim())) {
      comment.remove()
    }
  })

  ast.walkRules((rule) => {
    rule.selector = normalizeCssSelector(rule.selector)

    for (const node of rule.nodes ?? []) {
      if (node.type !== 'decl') {
        continue
      }
      node.value = normalizeCssValue(node.value)
    }

    sortRuleDeclarations(rule)
  })

  return ast.toString()
}

async function formatWxss(wxss        ) {
  return canonicalWxss(normalizeWxssForSnapshot(wxss))
}

function normalizeSegment(value        ) {
  return value.replace(LEADING_SLASH_RE, '').replace(TRAILING_SLASH_RE, '')
}

function pushUnique(list          , seen             , value        ) {
  if (!value || seen.has(value)) {
    return
  }
  seen.add(value)
  list.push(value)
}

function resolvePages(config                     ) {
  const pages           = []
  const seen = new Set        ()

  if (Array.isArray(config.pages)) {
    for (const page of config.pages) {
      if (typeof page !== 'string') {
        continue
      }
      pushUnique(pages, seen, normalizeSegment(page))
    }
  }

  const subPackages = [
    ...(Array.isArray(config.subPackages) ? config.subPackages : []),
    ...(Array.isArray(config.subpackages) ? config.subpackages : []),
  ]

  for (const subPackage of subPackages) {
    if (!subPackage || typeof subPackage !== 'object') {
      continue
    }
    const root = typeof subPackage.root === 'string' ? normalizeSegment(subPackage.root) : ''
    const subPages = Array.isArray(subPackage.pages) ? subPackage.pages : []
    for (const page of subPages) {
      if (typeof page !== 'string') {
        continue
      }
      const normalizedPage = normalizeSegment(page)
      if (!normalizedPage) {
        continue
      }
      const combined = root ? `${root}/${normalizedPage}` : normalizedPage
      if (root && normalizedPage.startsWith(`${root}/`)) {
        pushUnique(pages, seen, normalizedPage)
      }
      else {
        pushUnique(pages, seen, combined)
      }
    }
  }

  return pages
}

function assertTemplateRouteCoverage(pages          , routes                    ) {
  const normalize = (route        ) => route.replace(/^\/+|\/+$/g, '')
  const planned = routes.map(item => normalize(item.route))
  if (new Set(planned).size !== planned.length) {
    throw new Error('Template DOM acceptance contains duplicate routes')
  }
  const missing = pages.filter(page => !planned.includes(normalize(page)))
  const stale = planned.filter(route => !pages.some(page => normalize(page) === route))
  if (missing.length || stale.length) {
    throw new Error(`Template DOM route coverage mismatch: missing=${missing.join(',')} stale=${stale.join(',')}`)
  }
  for (const item of routes) {
    if (!item.steps.length || item.steps.some(step => normalize(step.route) !== normalize(item.route))) {
      throw new Error(`Template DOM checkpoints must belong to their declared route: ${item.route}`)
    }
  }
}
export { formatWxml, formatWxss, normalizeWxmlForSnapshot, resolvePages, assertTemplateRouteCoverage, UNSUPPORTED_VUE_EVENT_SHORTHAND_RE };
