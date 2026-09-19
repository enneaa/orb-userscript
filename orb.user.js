// ==UserScript==
// @name         orb
// @namespace    orb-floating
// @version      1.7.1
// @description  悬浮球:翻页/记录/剪藏/翻译/对话 + 划词批注/划词/对话/搜索
// @author       orb
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_deleteValue
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==
/* eslint-disable */
(function () {
  'use strict';
  if (typeof window !== 'undefined' && window.__ORB_TM__) return;
  if (typeof window !== 'undefined') window.__ORB_TM__ = true;

  // ============================================================
  // §1  PURE UTILITIES  (testable from Node, no DOM/network)
  // ============================================================
  const Pure = {};

  // ---- 1.1  Base64 (UTF-8 safe) ----
  Pure.b64enc = function b64enc(str) {
    const s = String(str == null ? '' : str);
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(s, 'utf8').toString('base64');
    }
    // Browser path
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  };
  Pure.b64dec = function b64dec(b64) {
    const s = String(b64 == null ? '' : b64);
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(s, 'base64').toString('utf8');
    }
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  };

  // ---- 1.2  Date formatting ----
  Pure.dateFmt = function dateFmt(d) {
    const x = d instanceof Date ? d : new Date();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return {
      date: x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()),
      year: '' + x.getFullYear(),
      month: pad(x.getMonth() + 1),
      day: pad(x.getDate()),
      hour: pad(x.getHours()),
      minute: pad(x.getMinutes()),
    };
  };

  // ---- 1.3  File name sanitisation ----
  Pure.sanitizeName = function sanitizeName(raw, allowSlash) {
    let s = String(raw == null ? '' : raw);
    s = s.replace(/[\x00-\x1f\x7f]/g, '').trim();
    if (!s) s = 'untitled';
    if (allowSlash) {
      s = s.replace(/[\\<>:"|?*]/g, '_');
    } else {
      s = s.replace(/[\\/<>:"|?*\n\r\t]/g, '_');
    }
    s = s.replace(/^\.+/, '').replace(/\s+$/g, '').replace(/\s+/g, ' ');
    if (s.length > 120) s = s.slice(0, 120);
    if (!s) s = 'untitled';
    return s;
  };

  // ---- 1.4  Should-skip heuristic for translation ----
  // Skip if text already mostly matches target language alphabet or is empty/short.
  Pure.shouldSkip = function shouldSkip(text, targetLang) {
    if (!text) return true;
    const t = String(text).trim();
    if (t.length === 0) return true;
    // Pure CJK punctuation only?
    if (/^[\s\u3000-\u303f\uff00-\uffef]+$/.test(t)) return true;
    // Pure ASCII punctuation / symbols / numbers only (no letters at all).
    if (/^[\s\p{P}\p{S}\d]+$/u.test(t) && !/[\p{Letter}]/u.test(t)) return true;
    const tl = String(targetLang || '').toLowerCase();
    // If target is CJK family and text already has CJK chars heavily, skip.
    const cjkRatio = (t.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length / Math.max(1, t.length);
    if (/^(cmn|zh|chi|chs|cht|zh-cn|zh-tw|ja|jp|ko|kor)$/i.test(tl) && cjkRatio > 0.55) return true;
    // If target is English/Latin and text is already Latin heavy with mostly ascii letters, skip.
    if (/^(en|eng|en-us|en-gb)$/i.test(tl) && /^[A-Za-z0-9\s\p{P}]+$/u.test(t) && cjkRatio < 0.05) {
      if (t.length > 2 && !/^[\W\d_]+$/.test(t)) return true;
    }
    return false;
  };

  // ---- 1.5  Lazy-image attribute resolution ----
  // For an <img> node, walk lazy-load attribute candidates.
  Pure.resolveImgSrc = function resolveImgSrc(img) {
    if (!img) return '';
    if (img.src && !img.src.startsWith('data:') && img.getAttribute('src')) {
      // Use the literal attribute value so we catch lazy URLs.
    }
    const attrs = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-image', 'data-hi-res-src'];
    for (const a of attrs) {
      const v = img.getAttribute(a);
      if (v && v.trim()) return v.trim();
    }
    const srcset = img.getAttribute('data-srcset') || img.getAttribute('srcset');
    if (srcset) {
      const first = srcset.split(',')[0].trim().split(/\s+/)[0];
      if (first) return first;
    }
    return img.currentSrc || img.src || '';
  };

  // ---- 1.6  Template engine ----
  // Supports:
  //   {{var}}                  - replace
  //   {{var JSON}}             - JSON.stringify (no extra whitespace)
  //   {{#if var}}...{{/if}}    - block; nested allowed
  //   {{#eachLine var}}...{{line}}...{{/eachLine}}
  // Whitelist: title, url, hostname, author, excerpt, content, selection, comment,
  //            date, year, month, day, hour, minute
  const VAR_WHITELIST = new Set([
    'title', 'url', 'hostname', 'author', 'excerpt', 'content',
    'selection', 'context', 'comment',
    'date', 'time', 'year', 'month', 'day', 'hour', 'minute',
    'lang', 'langName',
  ]);

  Pure._normVars = function _normVars(vars) {
    const out = {};
    if (!vars) return out;
    for (const k of Object.keys(vars)) {
      out[k] = vars[k] == null ? '' : vars[k];
    }
    return out;
  };

  Pure._varTruthy = function _varTruthy(v) {
    if (v == null) return false;
    if (typeof v === 'string') return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return !!v;
  };

  // Parse tokens: returns array of {type, ...}
  //   {type:'text', value}
  //   {type:'var', name, json}
  //   {type:'if',   name, body:tokens, negated:bool}
  //   {type:'each', name, body:tokens}
  //   {type:'end'}
  const _tplCache = new Map();   // 模板解析结果缓存（同一模板只解析一次）
  Pure._parseTpl = function _parseTpl(src) {
    const hit = _tplCache.get(src);
    if (hit) return hit;
    const tokens = [];
    let i = 0;
    let buf = '';
    const flushText = () => {
      if (buf.length) {
        tokens.push({ type: 'text', value: buf });
        buf = '';
      }
    };
    // Stack-based scanner: lets `#if` / `#eachLine` nest correctly with mixed
    // closes. We keep entries like { kind: 'if'|'eachLine', openEnd, bodyStart }.
    // Body scanning uses the same `i` cursor but reads from the *current* src.
    const scanBlockBody = (start, closeTag) => {
      // start: index just after the opener's `}}`
      // closeTag: '/if' | '/eachLine'
      // returns { body: string, end: index just after the closer's `}}` } or null on unterminated
      let j = start;
      const stack = [{ kind: closeTag === '/if' ? 'if' : 'eachLine' }];
      while (j < src.length) {
        const o = src.indexOf('{{', j);
        if (o === -1) return null;
        const c = src.indexOf('}}', o + 2);
        if (c === -1) return null;
        const segInner = src.slice(o + 2, c).trim();
        if (segInner.startsWith('#if ')) {
          stack.push({ kind: 'if' });
        } else if (segInner.startsWith('#eachLine ')) {
          stack.push({ kind: 'eachLine' });
        } else if (segInner === '/if') {
          const top = stack[stack.length - 1];
          if (top && top.kind === 'if') stack.pop();
          // if it doesn't match, ignore (malformed) so we don't break the scan
        } else if (segInner === '/eachLine') {
          const top = stack[stack.length - 1];
          if (top && top.kind === 'eachLine') stack.pop();
        }
        if (stack.length === 0) {
          return { body: src.slice(start, o), end: c + 2 };
        }
        j = c + 2;
      }
      return null;
    };
    while (i < src.length) {
      if (src[i] === '{' && src[i + 1] === '{') {
        const end = src.indexOf('}}', i + 2);
        if (end === -1) {
          buf += src.slice(i);
          break;
        }
        const inner = src.slice(i + 2, end).trim();
        if (inner.startsWith('#if ')) {
          flushText();
          const name = inner.slice(4).trim();
          const res = scanBlockBody(end + 2, '/if');
          if (!res) {
            buf += src.slice(i, end + 2);
            i = end + 2;
            continue;
          }
          tokens.push({ type: 'if', name, body: Pure._parseTpl(res.body) });
          i = res.end;
          continue;
        }
        if (inner.startsWith('#eachLine ')) {
          flushText();
          const name = inner.slice('#eachLine '.length).trim();
          const res = scanBlockBody(end + 2, '/eachLine');
          if (!res) {
            buf += src.slice(i, end + 2);
            i = end + 2;
            continue;
          }
          tokens.push({ type: 'eachLine', name, body: Pure._parseTpl(res.body) });
          i = res.end;
          continue;
        }
        // variable: {{name}} or {{name JSON}}
        const parts = inner.split(/\s+/);
        const name = parts[0];
        const isJson = parts.slice(1).join(' ').toUpperCase() === 'JSON';
        flushText();
        tokens.push({ type: 'var', name, json: isJson });
        i = end + 2;
        continue;
      }
      buf += src[i];
      i++;
    }
    flushText();
    if (_tplCache.size >= 200) _tplCache.clear();
    _tplCache.set(src, tokens);
    return tokens;
  };

  Pure._renderTokens = function _renderTokens(tokens, vars, extraAllowed) {
    const v = Pure._normVars(vars);
    let out = '';
    for (const t of tokens) {
      if (t.type === 'text') {
        out += t.value;
      } else if (t.type === 'var') {
        const allowed = VAR_WHITELIST.has(t.name) || (extraAllowed && extraAllowed.has(t.name));
        if (!allowed) continue;
        const val = v[t.name];
        if (t.json) {
          try { out += JSON.stringify(val == null ? '' : val); }
          catch (e) { out += ''; }
        } else {
          out += val == null ? '' : String(val);
        }
      } else if (t.type === 'if') {
        const val = v[t.name];
        if (Pure._varTruthy(val)) {
          out += Pure._renderTokens(t.body, v, extraAllowed);
        }
      } else if (t.type === 'eachLine') {
        if (!VAR_WHITELIST.has(t.name)) continue;
        const val = v[t.name];
        if (val == null) continue;
        const lines = String(val).split(/\r?\n/);
        const innerAllowed = new Set(extraAllowed || []);
        innerAllowed.add('line');
        for (const line of lines) {
          out += Pure._renderTokens(t.body, { ...v, line }, innerAllowed);
        }
      }
    }
    return out;
  };

  Pure.templateRender = function templateRender(tpl, vars) {
    if (tpl == null) return '';
    const tokens = Pure._parseTpl(String(tpl));
    return Pure._renderTokens(tokens, vars || {});
  };

  // 统一收集模板变量：scope = { selection, pageContent, lang, langName, extra }
  Pure.getTemplateVars = function getTemplateVars(scope) {
    scope = scope || {};
    const now = new Date();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    const doc = (typeof document !== 'undefined') ? document : { title: '', location: { href: '', hostname: '' } };
    const loc = doc.location || { href: '', hostname: '' };
    const selection = scope.selection || '';
    const pageContent = scope.pageContent || scope.content || '';
    const content = selection || pageContent;
    const vars = {
      title: doc.title || '',
      url: loc.href || '',
      hostname: loc.hostname || '',
      author: scope.author || '',
      excerpt: scope.excerpt || '',
      content: content,
      selection: selection,
      context: pageContent,
      comment: scope.comment || '',
      date: now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()),
      time: pad(now.getHours()) + ':' + pad(now.getMinutes()),
      year: '' + now.getFullYear(),
      month: pad(now.getMonth() + 1),
      day: pad(now.getDate()),
      hour: pad(now.getHours()),
      minute: pad(now.getMinutes()),
      lang: scope.lang || '',
      langName: scope.langName || '',
    };
    if (scope.extra) {
      for (const k of Object.keys(scope.extra)) vars[k] = scope.extra[k];
    }
    return vars;
  };

  // ---- 1.7  Build note frontmatter + body (pure part) ----
  // Returns {frontmatter, body, full} for an Obsidian-style note.
  Pure.buildNote = function buildNote(parts) {
    const fmTpl = parts.frontmatterTpl || '';
    const bodyTpl = parts.bodyTpl || '';
    const vars = parts.vars || {};
    const fm = Pure.templateRender(fmTpl, vars);
    const body = Pure.templateRender(bodyTpl, vars);
    const full = (fm ? (fm.endsWith('\n') ? fm : fm + '\n') + '\n' : '') + body;
    return { frontmatter: fm, body, full };
  };

  // ---- 1.8  Build Readability → Markdown frontmatter and body given fixed inputs ----
  // (Used by Clip; we keep the DOM walking in the browser, but conversion/markdown
  // shape lives here so tests can pin the structure.)
  Pure.clipMarkdown = function clipMarkdown(args) {
    const { title, author, excerpt, contentHtml, url, dateVars } = args;
    // Note: callers should pass already-Markdown content (via turndown).
    const vars = Pure.getTemplateVars({
      selection: contentHtml || '',
      author: author || '',
      excerpt: excerpt || '',
    });
    // 覆盖为传入的标题/URL（clipMarkdown 可能在非浏览器环境调用）
    if (title) vars.title = title;
    if (url) { vars.url = url; try { vars.hostname = new URL(url).hostname; } catch (e) { /* ignore */ } }
    if (dateVars) { vars.date = dateVars.date || vars.date; vars.year = dateVars.year || vars.year; vars.month = dateVars.month || vars.month; vars.day = dateVars.day || vars.day; vars.hour = dateVars.hour || vars.hour; vars.minute = dateVars.minute || vars.minute; }
    return vars;
  };

  // ---- 1.12  剪藏外部库按需加载（Readability/Turndown/GFM;多 CDN fallback） ----
  // 不再 @require:脚本启动零网络依赖;首次剪藏/打开对话面板时预热,失败走 innerText 降级。
  const LIB_CDNS = {
    readability: [
      'https://cdn.jsdelivr.net/npm/@mozilla/readability@0.5.0/Readability.js',
      'https://unpkg.com/@mozilla/readability@0.5.0/Readability.js',
    ],
    turndown: [
      'https://cdn.jsdelivr.net/npm/turndown@7.2.0/dist/turndown.js',
      'https://unpkg.com/turndown@7.2.0/dist/turndown.js',
    ],
    gfm: [
      'https://cdn.jsdelivr.net/npm/turndown-plugin-gfm@1.0.2/dist/turndown-plugin-gfm.js',
      'https://unpkg.com/turndown-plugin-gfm@1.0.2/dist/turndown-plugin-gfm.js',
    ],
  };
  const _libLoaders = {};
  async function loadLib(name) {
    if (_libLoaders[name] && _libLoaders[name].done) return true;
    if (_libLoaders[name]) return _libLoaders[name];
    const urls = LIB_CDNS[name] || [];
    const p = new Promise((resolve) => {
      let i = 0, settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve(false); } }, 12000);
      const next = () => {
        if (settled) return;
        if (i >= urls.length) { settled = true; clearTimeout(timer); resolve(false); return; }
        const s = document.createElement('script');
        s.src = urls[i++];
        s.async = true;
        s.onload = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(true); } };
        s.onerror = () => { s.remove(); next(); };
        (document.head || document.documentElement).appendChild(s);
      };
      next();
    });
    _libLoaders[name] = p;
    p.then(() => { _libLoaders[name].done = true; });
    return p;
  }
  // 剪藏核心库(Readability + Turndown)就绪即返回 true;GFM 有 try/catch 兜底不强求。
  async function ensureClipLibs() {
    if (typeof Readability !== 'undefined' && typeof TurndownService !== 'undefined') return true;
    await Promise.all([loadLib('readability'), loadLib('turndown'), loadLib('gfm')]);
    return typeof Readability !== 'undefined' && typeof TurndownService !== 'undefined';
  }

  // ---- 1.10  Trim text to N tokens roughly ----
  Pure.truncateByChars = function truncateByChars(s, n) {
    s = String(s == null ? '' : s);
    if (s.length <= n) return s;
    return s.slice(0, n);
  };

  // ---- 1.11  轻量 Markdown 渲染(AI 回复用;零依赖;先转义后渲染,防注入) ----
    Pure.md = function md(text) {
      if (text == null) return '';
      let s = String(text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      // 代码块(先处理,内容原样保留,未闭合时渲染到结尾)
      const blocks = [];
      s = s.replace(/```[ \t]*([^\n`]*)[\r\n]+?([\s\S]*?)(?:```|$)/g, (m, lang, code) => {
        const idx = blocks.length;
        const cls = lang ? ' class="lang-' + lang.replace(/[^\w-]/g, '') + '"' : '';
        blocks.push('<pre><code' + cls + '>' + code.replace(/[\r\n]+$/, '') + '</code></pre>');
        return '\u0001' + idx + '\u0001';
      });
      // 行内码(占位保护,避免内部语法被二次处理)
      const codes = [];
      s = s.replace(/`([^`\n]+?)`/g, (m, c) => {
        const idx = codes.length;
        codes.push('<code>' + c + '</code>');
        return '\u0002' + idx + '\u0002';
      });
      // 行内样式与链接
      s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/~~([^~]+?)~~/g, '<del>$1</del>');
      s = s.replace(/(^|[^\w*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
      s = s.replace(/\[([^\]\n]+)\]\((https?:|mailto:)([^)\s]+)\)/g, '<a href="$2$3" target="_blank" rel="noopener">$1</a>');
      s = s.replace(/\u0002(\d+)\u0002/g, (m, i) => codes[i]);
      // 行级块:标题/水平线/引用/列表/代码块占位/普通行
      const lines = s.split('\n');
      let out = '', listTag = '';
      const flush = () => { if (listTag) { out += '</' + listTag + '>'; listTag = ''; } };
      const open = (tag) => { if (listTag !== tag) { flush(); out += '<' + tag + '>'; listTag = tag; } };
      for (let idx = 0; idx < lines.length; idx++) {
        const raw = lines[idx];
        const line = raw.trim();
        if (!line) {
          // 空行：检查后续是否还有列表项，有则不关闭列表（避免列表被打断重新从1编号）
          let nextIsList = false;
          for (let k = idx + 1; k < lines.length; k++) {
            const t = lines[k].trim();
            if (!t) continue;
            nextIsList = /^[-*]\s+/.test(t) || /^\d+[.)]\s+/.test(t);
            break;
          }
          if (listTag && nextIsList) continue;
          flush();
          out += '<div class="md-gap"></div>';
          continue;
        }
        const probe = line.replace(/&gt;/g, '>');   // 转义后的 > 还原,便于块级匹配
        const preM = line.match(/^\u0001(\d+)\u0001$/);
        if (preM) { flush(); out += '\u0001' + preM[1] + '\u0001'; continue; }
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) { flush(); const n = h[1].length; out += '<h' + n + '>' + h[2] + '</h' + n + '>'; continue; }
        if (/^(---+|\*\*\*+|___+)$/.test(line)) { flush(); out += '<hr>'; continue; }
        if (/^>\s?/.test(probe)) { flush(); out += '<blockquote>' + line.replace(/^&gt;\s?/, '') + '</blockquote>'; continue; }
        const ul = line.match(/^[-*]\s+(.*)$/);
        if (ul) { open('ul'); out += '<li>' + ul[1] + '</li>'; continue; }
        const ol = line.match(/^\d+[.)]\s+(.*)$/);
        if (ol) { open('ol'); out += '<li>' + ol[1] + '</li>'; continue; }
        flush();
        out += '<div class="md-line">' + line + '</div>';
      }
      flush();
      return out.replace(/\u0001(\d+)\u0001/g, (m, i) => blocks[i]);
    },

  Pure.escHtml = function escHtml(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  };
  Pure.hash = function hash(s) {
    let h = 5381;
    const str = String(s == null ? '' : s);
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h.toString(36);
  };
  Pure.langName = function langName(code) {
    const c = String(code || '').toLowerCase();
    const names = {
      // 服务实际使用的代码 (BCP 47 / 639-1)
      zh: '简体中文', 'zh-tw': '繁体中文', en: 'English', ja: 'Japanese', ko: 'Korean',
      fr: 'French', de: 'German', es: 'Spanish', ru: 'Russian', pt: 'Portuguese',
      it: 'Italian', nl: 'Dutch', ar: 'Arabic', hi: 'Hindi', bn: 'Bengali',
      th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', ms: 'Malay', tr: 'Turkish',
      uk: 'Ukrainian', pl: 'Polish', cs: 'Czech', sv: 'Swedish', da: 'Danish',
      fi: 'Finnish', no: 'Norwegian', el: 'Greek', he: 'Hebrew', yue: '粤语',
    };
    return names[c] || c;
  };

  // 错误信息友好化:把 HTTP 状态码/网络错误翻译成用户可理解的中文
  Pure.friendlyError = function friendlyError(e) {
    const msg = String((e && e.message) || e || '');
    let out = msg;
    if (/401|403/i.test(msg)) out = 'API Key 无效';
    else if (/404/i.test(msg)) out = '接口地址错误';
    else if (/429/i.test(msg)) out = '请求过于频繁';
    else if (/500|502|503|504/i.test(msg)) out = '服务端错误';
    else if (/timeout|超时/i.test(msg)) out = '请求超时';
    else if (/failed to fetch|network|网络|NetworkError|ECONNREFUSED/i.test(msg)) out = '网络错误';
    else if (/api.?key/i.test(msg)) out = 'API Key 无效';
    else if (/model/i.test(msg) && /not|exist|invalid/i.test(msg)) out = '模型不可用';
    return out;
  };

  // 外部点击关闭：返回 cleanup 函数，调用后移除监听
  Pure.outsideClick = function outsideClick(host, onOutside, suppressMs) {
    suppressMs = suppressMs == null ? 250 : suppressMs;
    const suppressUntil = Date.now() + suppressMs;
    const onDocDown = (e) => {
      if (Date.now() < suppressUntil) return;
      if (host.contains(e.target)) return;
      onOutside && onOutside(e);
    };
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('touchstart', onDocDown, true);
    return () => {
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('touchstart', onDocDown, true);
    };
  };

  // 统一创建 shadow DOM 面板宿主
  Pure.createHost = function createHost(styleCss) {
    const host = document.createElement('div');
    // 面板宿主标记：selectionchange 检测时跳过面板内部选区（不弹出划词子球）
    try { host.setAttribute('data-orb-panel', '1'); } catch (e) { /* ignore */ }
    const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    if (styleCss) {
      const style = document.createElement('style');
      style.textContent = styleCss;
      root.appendChild(style);
    }
    return { host, root };
  };

  // 输入框自动高度
  Pure.autoGrow = function autoGrow(ta, min, max) {
    if (!ta) return;
    min = min || 30;
    max = max || 200;
    ta.style.height = min + 'px';
    const h = Math.min(Math.max(ta.scrollHeight, min), max);
    ta.style.height = h + 'px';
  };

  // 统一错误处理
  Pure.handleError = function handleError(e, context) {
    const msg = Pure.friendlyError(e);
    try { Toast.show(msg, 3000, 'error'); } catch (err) { /* ignore */ }
    try { FloatBtn.setState('err', 3000); } catch (err) { /* ignore */ }
    console.error('[orb]' + (context ? ' ' + context : '') + ':', e);
  };

  // 移动端键盘适配：监听 visualViewport，键盘弹出时调整面板位置和高度
  Pure.keyboardAdapt = function keyboardAdapt(wrap, scrollSel) {
    if (!window.visualViewport) return function () {};
    let baseTop = null, baseMaxH = null, baseTransform = null;
    let checkpointTop = null;   // 键盘调整后设置的 top（未上移则为 null）
    let ticking = false;
    let adjusted = false;
    const onVV = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const vv = window.visualViewport;
        if (!vv) return;
        const keyboardH = Math.max(0, window.innerHeight - vv.height);
        if (keyboardH > 120) {
          // 首次调整前捕获基准位置：若用户打开面板后拖拽过，以拖拽后的位置为准
          if (baseTop === null) {
            baseTop = wrap.style.top || '';
            baseMaxH = wrap.style.maxHeight || '';
            baseTransform = wrap.style.transform || '';
            checkpointTop = baseTop;
          }
          // 键盘弹出：面板底部始终对齐键盘顶（输入框贴键盘），对话/记录面板行为一致。
          // 坐标统一用 layout viewport（getBoundingClientRect 与 vv.offsetTop+vv.height 同系），
          // 不再混入 window.scrollY，避免页面已滚动时过度上移。
          const availableH = vv.height - 16;
          const panelH = wrap.offsetHeight || 400;
          let changed = false;
          if (panelH > availableH) { wrap.style.maxHeight = availableH + 'px'; changed = true; }
          const rect = wrap.getBoundingClientRect();
          const realH = rect.height || Math.min(panelH, availableH);
          const panelBottomLimit = vv.offsetTop + vv.height - 8;
          const newTop = Math.max(8, panelBottomLimit - realH);
          // 仅在未调整过、或仍停在调整后位置（未被用户拖走）时重新对齐；
          // 已贴齐（|Δ|≤2px）则跳过，避免键盘内部 resize（候选词等）反复触发滚动。
          if (!adjusted || (wrap.style.top === checkpointTop && Math.abs(rect.top - newTop) > 2)) {
            // transform 居中面板（AIDialog 无锚点）临时改为 fixed 定位
            wrap.style.transform = 'none';
            wrap.style.top = newTop + 'px';
            checkpointTop = wrap.style.top;   // 记录调整后的位置，供收起时判断是否被用户拖走
            changed = true;
          }
          adjusted = changed;
          // 收缩后滚动指定区域到底（AIDialog 传 .body，保证最新消息可见）
          if (changed && scrollSel && wrap.querySelector) {
            const el = wrap.querySelector(scrollSel);
            if (el) el.scrollTop = el.scrollHeight;
          }
        } else if (adjusted) {
          // 键盘收起：仅在之前调整过时恢复（含高度收缩）。
          // 若键盘弹出后用户拖拽过面板（当前位置已偏离调整后位置），不再覆盖用户的拖拽结果。
          if (wrap.style.top === checkpointTop) {
            wrap.style.top = baseTop;
            wrap.style.transform = baseTransform;
          } else {
            // 拖走后保持 fixed 定位，否则恢复 translate 居中会让面板偏移半个身位
            wrap.style.transform = 'none';
          }
          wrap.style.maxHeight = baseMaxH;
          adjusted = false;
        }
      });
    };
    window.visualViewport.addEventListener('resize', onVV);
    window.visualViewport.addEventListener('scroll', onVV);
    return function cleanup() {
      // 面板在键盘还开着时被关闭：先恢复调整（否则下次打开位置错乱）
      if (adjusted) {
        if (wrap.style.top === checkpointTop) wrap.style.top = baseTop;
        wrap.style.maxHeight = baseMaxH;
        wrap.style.transform = baseTransform;
        adjusted = false;
      }
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', onVV);
        window.visualViewport.removeEventListener('scroll', onVV);
      }
    };
  };

  // 面板拖拽：handle 为拖拽手柄（通常是标题栏），拖拽时移动 wrap
  // 面板锚点定位：在锚点左侧显示，垂直居中，避让边缘
  Pure.positionPanel = function positionPanel(anchorX, anchorY, width, height, gap) {
    gap = gap == null ? 20 : gap;
    const x = Math.max(8, anchorX - gap - width);
    let y = anchorY - height / 2;
    y = Math.max(8, Math.min(window.innerHeight - height - 8, y));
    return { x, y };
  };

  // Expose for tests
  if (typeof globalThis !== 'undefined') {
    globalThis.__ORB_PURE__ = Pure;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Pure;
  }

  // ============================================================
  // §2  STORAGE  (GM_setValue / GM_getValue with JSON + key prefix)
  // ============================================================
  const STORAGE_PREFIX = 'orb::';
  const Storage = {
    _k(k) { return STORAGE_PREFIX + k; },
    get(k, def) {
      try {
        const raw = (typeof GM_getValue === 'function') ? GM_getValue(this._k(k), null) : null;
        if (raw == null) return def;
        if (typeof raw !== 'string') return raw;
        try { return JSON.parse(raw); } catch (e) { return raw; }
      } catch (e) { return def; }
    },
    set(k, v) {
      try {
        const val = (typeof v === 'string') ? v : JSON.stringify(v);
        if (typeof GM_setValue === 'function') GM_setValue(this._k(k), val);
        else if (typeof localStorage !== 'undefined') localStorage.setItem(this._k(k), val);
      } catch (e) { /* ignore */ }
    },
    del(k) {
      try {
        if (typeof GM_deleteValue === 'function') GM_deleteValue(this._k(k));
        else if (typeof GM_setValue === 'function') GM_setValue(this._k(k), '');
        else if (typeof localStorage !== 'undefined') localStorage.removeItem(this._k(k));
      } catch (e) { /* ignore */ }
    },
  };

  // ============================================================
  // §3  CONFIG  (defaults + deep merge + load/save)
  // ============================================================
  const DEFAULT_CONFIG = {
    notes: {
      provider: 'github',       // 'obsidian' | 'github' | 'gitee' | 'webdav'
      obsidian: { vault: '', folder: '' },
      github: { token: '', owner: '', repo: '', branch: 'main', folder: '' },
      gitee: { token: '', owner: '', repo: '', branch: 'master', folder: '' },
      webdav: { url: '', username: '', password: '' },
      templates: {
        frontmatter: '---\ntitle: {{title JSON}}\nurl: {{url}}\nhost: {{hostname}}\nauthor: {{author}}\ndate: {{date}}\ntags: [orb]\n---\n',
        clipBody: '# {{title}}\n\n> {{excerpt}}\n\n- 来源:{{url}}\n- 作者:{{author}}\n- 收录:{{date}}\n\n---\n\n{{content}}\n',
        annotateBody: '# {{title}} 批注\n\n- 来源:{{url}}\n- 时间:{{date}}\n\n> {{selection}}\n\n{{#if comment}}> {{comment}}\n{{/if}}\n',
        annotateSnippet: '> [!quote] {{title}}\n> {{selection}}\n>{{#if comment}} {{comment}}{{/if}}\n> — [link]({{url}})\n',
        noteBody: '# {{title}}\n\n{{#eachLine comment}}{{line}}\n{{/eachLine}}\n',
        // 保存路径（含文件名，支持 {{title}} 变量；记录/剪藏分开设置）
        paths: {
          note: { path: 'notes/{{title}}.md' },
          clip: { path: 'clips/{{title}}.md' },   // 剪藏/批注/摘抄 共用
        },
      },
    },
    translate: {
      provider: 'edge',         // 'edge' | 'tencent' | 'ali' | 'ai'
      target: 'zh',             // 目标语言 (BCP 47/639-1 代码)
      autoPage: false,          // 页面加载后自动翻译外文内容
      aiService: 'OpenAI',      // provider='ai' 时使用的 AI 服务（services[].name）
      aiPrompt: 'You are a professional translation engine. Translate the user message into {{lang}}. Output ONLY the translation, no explanations, no quotes, no code fences.',
    },
    ai: {
      // AI 服务池（独立模块，设置面板可增删改），kind = 'openai' | 'anthropic'
      services: [
        { name: 'OpenAI', kind: 'openai', baseURL: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini', enableSearch: false },
        { name: 'Claude Haiku', kind: 'anthropic', baseURL: 'https://api.anthropic.com', apiKey: '', model: 'claude-3-5-haiku-latest', enableSearch: false },
        { name: 'Claude Sonnet', kind: 'anthropic', baseURL: 'https://api.anthropic.com', apiKey: '', model: 'claude-3-5-sonnet-latest', enableSearch: false },
        { name: 'Claude Opus', kind: 'anthropic', baseURL: 'https://api.anthropic.com', apiKey: '', model: 'claude-3-opus-latest', enableSearch: false },
      ],
      chatService: 'OpenAI',    // AI 对话使用的服务（services[].name，服务内单模型）
      // Chat dialog top-bar prompt presets
      presets: [
        { name: '总结', prompt: '请用 3-5 个要点总结以下内容，保留关键信息和数据，直接输出结果。\n\n{{content}}' },
        { name: '解释', prompt: '请用通俗易懂的中文解释以下内容，如含专业术语请简要说明，直接输出结果。\n\n{{content}}' },
        { name: '翻译', prompt: '请将以下内容翻译成中文，保留原文格式、代码块和专有名词，只输出译文。\n\n{{content}}' },
        { name: '改写', prompt: '请用更简洁流畅的中文改写以下内容，保持原意，直接输出结果。\n\n{{content}}' },
        { name: '润色', prompt: '请优化以下内容的表达，使其更通顺、专业，保持原意，直接输出结果。\n\n{{content}}' },
        { name: '纠错', prompt: '请找出以下内容中的语法、拼写和逻辑错误，给出修正后的版本，直接输出结果。\n\n{{content}}' },
        { name: '代码解释', prompt: '请逐行解释以下代码的功能和逻辑，用中文说明，直接输出结果。\n\n{{content}}' },
        { name: '提取要点', prompt: '请从以下内容中提取关键信息，以列表形式输出，直接输出结果。\n\n{{content}}' },
      ],
      includePageContent: true,
    },
    selection: {
      threshold: 2,
      debounceMs: 300,
      defaultAction: '解释', // 划词后自动执行的提示词预设名 | 'none'（不自动执行，手动选胶囊）
      aiService: 'OpenAI',   // 划词 AI 处理使用的服务（services[].name，服务内单模型）
    },
    search: {
      // URL 模板用 %s 作为搜索词变量;SearchPop.show 会做替换
      engines: [
        { name: 'Google', url: 'https://www.google.com/search?q=%s' },
        { name: 'Bing',   url: 'https://www.bing.com/search?q=%s' },
        { name: 'Baidu',  url: 'https://www.baidu.com/s?wd=%s' },
        { name: '知乎',   url: 'https://www.zhihu.com/search?type=content&q=%s' },
        { name: 'GitHub', url: 'https://github.com/search?q=%s' },
      ],
    },
    ball: {
      topPct: 0.45,            // 0-1,纵向位置(由 Panel 滑块控制)
      edge: 16,                // 悬浮球离页面右边缘的距离(px)
      doubleClickAction: 'note',  // 双击主球触发的动作 id(默认快速记录)
    },
    balls: {
      global: ['flip', 'note', 'clip', 'translate', 'chat'],
      selection: ['annotate', 'word', 'chat', 'search'],
    },
  };

  function _isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function _deepMerge(target, src) {
    if (!_isObj(src)) return target;
    for (const k of Object.keys(src)) {
      const sv = src[k];
      if (_isObj(sv)) {
        if (!_isObj(target[k])) target[k] = {};
        _deepMerge(target[k], sv);
      } else if (Array.isArray(sv)) {
        target[k] = sv.slice();
      } else {
        target[k] = sv;
      }
    }
    return target;
  }

  const Config = {
    data: null,
    load() {
      const stored = Storage.get('config', null);
      const data = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      if (stored) _deepMerge(data, stored);
      this.data = data;
      return data;
    },
    save() {
      if (!this.data) this.data = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      Storage.set('config', this.data);
    },
    reset() {
      this.data = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      this.save();
    },
    // 保存白名单自动推导：路径存在于 DEFAULT_CONFIG 即允许保存（新增字段无需手动维护白名单）
    hasPath(path) {
      let o = DEFAULT_CONFIG;
      for (const k of String(path).split('.')) {
        if (o == null || typeof o !== 'object' || !(k in o)) return false;
        o = o[k];
      }
      return true;
    },
    patch(path, val) {
      // path like 'translate.target'
      if (!this.data) this.load();
      // 类型校验:已知数字字段转 Number,避免字符串污染
      const _numPaths = ['selection.threshold', 'selection.debounceMs'];
      if (_numPaths.includes(path)) {
        const n = Number(val);
        val = isNaN(n) ? val : n;
      }
      const parts = path.split('.');
      let cur = this.data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!_isObj(cur[parts[i]])) cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = val;
      this.save();
    },
  };

  // ============================================================
  // §4  STATE  (singleton: idle / busy / playing / error)
  // ============================================================
  const State = {
    mode: 'global',            // 'global' | 'selection'
    busy: null,                // null | {kind, abort, startedAt}
    selectionText: '',
  };
  function isBusy() { return !!State.busy; }
  function canStart(kind) {
    if (State.busy && State.busy.kind !== kind) return false;
    return true;
  }
  function setBusy(kind, abort) {
    State.busy = { kind, abort: abort || null, startedAt: Date.now() };
    try { FloatBtn.setState('busy'); } catch (e) { /* ignore */ }
  }
  function clearBusy(kind) {
    if (State.busy && State.busy.kind === kind) {
      State.busy = null;
      try { FloatBtn.setState(''); } catch (e) { /* ignore */ }
    }
  }

  // ============================================================
  // §5  GM_* WRAPPER  (network + clipboard)
  // ============================================================
  const GM = {
    request(opts) {
      // Returns a Promise<{status, response, responseText, finalUrl}>.
      return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest !== 'function') {
          return reject(new Error('GM_xmlhttpRequest unavailable'));
        }
        let done = false;
        const timeoutMs = (opts && opts.timeout) || 45000;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          reject(new Error('timeout after ' + timeoutMs + 'ms'));
        }, timeoutMs);
        try {
          GM_xmlhttpRequest({
            method: (opts && opts.method) || 'GET',
            url: opts.url,
            headers: opts.headers || {},
            data: opts.data,
            responseType: opts.responseType || '',
            onload(resp) {
              if (done) return;
              done = true;
              clearTimeout(timer);
              resolve({
                status: resp.status || 0,
                response: resp.response,
                responseText: resp.responseText,
                finalUrl: resp.finalUrl || opts.url,
              });
            },
            onerror(e) {
              if (done) return;
              done = true;
              clearTimeout(timer);
              reject(new Error('network error: ' + (e && e.error ? e.error : 'unknown')));
            },
            ontimeout() {
              if (done) return;
              done = true;
              clearTimeout(timer);
              reject(new Error('timeout'));
            },
          });
        } catch (e) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(e);
        }
      });
    },
    setClipboard(text) {
      try {
        if (typeof GM_setClipboard === 'function') {
          GM_setClipboard(String(text == null ? '' : text), 'text');
          return true;
        }
      } catch (e) { /* ignore */ }
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          navigator.clipboard.writeText(String(text == null ? '' : text));
          return true;
        }
      } catch (e) { /* ignore */ }
      return false;
    },
  };

  // ============================================================
  // §6  SERVICES — Notes (Obsidian URI / GitHub / Gitee / WebDAV)
  // ============================================================
  const Services = {};
  Services.Notes = {
    _path(title, action) {
      const t = Config.data.notes.templates;
      const a = action === 'note' ? 'note' : 'clip';   // 剪藏/批注/摘抄 共用 clip
      const tpl = (t.paths && t.paths[a] && t.paths[a].path) || '{{title}}.md';
      const rendered = Pure.templateRender(tpl, { title: title || 'untitled' });
      // 清理路径：去掉首尾斜杠，sanitize 每一段
      let result = rendered.split('/').map((s, i, arr) =>
        i === arr.length - 1 ? Pure.sanitizeName(s, false) : Pure.sanitizeName(s, true)
      ).filter(Boolean).join('/');
      if (result && !/\.md$/i.test(result)) result += '.md';
      return result;
    },
    _renderAll(parts) {
      const vars = parts.vars || {};
      const tpls = Config.data.notes.templates;
      const front = Pure.templateRender(tpls.frontmatter, vars);
      const body = Pure.templateRender(parts.bodyTpl || tpls.clipBody, vars);
      const full = (front ? front + (front.endsWith('\n') ? '' : '\n') + '\n' : '') + body;
      return { frontmatter: front, body, full };
    },
    async save(parts) {
      const p = Config.data.notes;
      const provider = p.provider;
      if (provider === 'obsidian') return this._saveObsidian(parts);
      if (provider === 'github')   return this._saveGitHub(parts, 'github');
      if (provider === 'gitee')    return this._saveGitHub(parts, 'gitee');
      if (provider === 'webdav')   return this._saveWebDAV(parts);
      throw new Error('unknown notes provider: ' + provider);
    },
    async _saveObsidian(parts) {
      // Obsidian 走 URI scheme:优先剪贴板,失败则 URI 内嵌 content(过长时报错)
      const p = Config.data.notes.obsidian;
      const path = this._path(parts.vars.title, parts.action);
      const rendered = this._renderAll(parts);
      const vaultParam = p.vault ? 'vault=' + encodeURIComponent(p.vault) + '&' : '';
      let via = 'clipboard';
      let uri = 'obsidian://new?' + vaultParam + 'file=' + encodeURIComponent(path) + '&clipboard=true';
      const clipboardOk = GM.setClipboard(rendered.full);
      if (!clipboardOk) {
        if (rendered.full.length > 1_800_000) {
          throw new Error('剪贴板不可用且内容过长,无法通过 Obsidian URI 内嵌');
        }
        via = 'uri';
        uri = 'obsidian://new?' + vaultParam + 'file=' + encodeURIComponent(path) + '&content=' + encodeURIComponent(rendered.full);
      }
      try { window.open(uri, '_blank'); } catch (e) { try { location.href = uri; } catch (e2) { /* ignore */ } }
      return { ok: true, path, via: 'obsidian-' + via };
    },
    async _saveGitHub(parts, kind) {
      const p = Config.data.notes[kind];
      if (!p.token || !p.owner || !p.repo) throw new Error(kind + ' notes: missing token/owner/repo');
      const path = this._path(parts.vars.title, parts.action);
      const rendered = this._renderAll(parts);
      const base = kind === 'gitee' ? 'https://gitee.com/api/v5' : 'https://api.github.com';
      const defaultBranch = kind === 'gitee' ? 'master' : 'main';
      const encPath = path.split('/').map(encodeURIComponent).join('/');
      // Gitee: token 走 query 参数;GitHub: Bearer + API Version header
      let url = base + '/repos/' + encodeURIComponent(p.owner) + '/' + encodeURIComponent(p.repo) + '/contents/' + encPath;
      const headers = { 'Content-Type': 'application/json;charset=UTF-8' };
      if (kind === 'gitee') {
        url += '?access_token=' + encodeURIComponent(p.token);
      } else {
        headers['Authorization'] = 'Bearer ' + p.token;
        headers['Accept'] = 'application/vnd.github+json';
        headers['X-GitHub-Api-Version'] = '2022-11-28';
      }
      const getUrl = url + (url.includes('?') ? '&' : '?') + 'ref=' + encodeURIComponent(p.branch || defaultBranch);
      // 1) GET 检查是否已存在(仅 404 视为不存在;其他错误抛出,避免误创建)
      let existing = null;
      const r = await GM.request({ method: 'GET', url: getUrl, headers });
      if (r.status === 200) {
        const j = typeof r.response === 'string' ? JSON.parse(r.response) : r.response;
        if (j && j.sha) existing = { sha: j.sha, content: j.content };
      } else if (r.status !== 404) {
        throw new Error(kind + ' 读取文件失败: HTTP ' + r.status + ' ' + ((r.responseText || '').slice(0, 400)));
      }
      // 2) 写入(追加 or 新建;Gitee 新建用 POST)
      let finalContent, action, method;
      if (existing) {
        const decoded = Pure.b64dec((existing.content || '').replace(/\n/g, ''));
        finalContent = decoded.replace(/\s+$/, '') + '\n\n' + rendered.body + '\n';
        action = '追加';
        method = 'PUT';
      } else {
        finalContent = rendered.full;
        action = '新建';
        method = kind === 'gitee' ? 'POST' : 'PUT';
      }
      const body = { message: action + ' ' + path + ' via orb', branch: p.branch || defaultBranch, content: Pure.b64enc(finalContent) };
      if (existing) body.sha = existing.sha;
      const r2 = await GM.request({ method, url, headers, data: JSON.stringify(body) });
      if (r2.status < 200 || r2.status >= 300) {
        throw new Error(kind + ' 写入失败: HTTP ' + r2.status + ' ' + ((r2.responseText || '').slice(0, 400)));
      }
      return { ok: true, path, appended: !!existing, via: kind };
    },
    async _saveWebDAV(parts) {
      const p = Config.data.notes.webdav;
      if (!p.url || !p.username || !p.password) throw new Error('WebDAV: missing url/username/password');
      const path = this._path(parts.vars.title, parts.action);
      const rendered = this._renderAll(parts);
      // 拼接完整 URL：base url + 路径
      let base = p.url.replace(/\/+$/, '');
      const fullUrl = base + '/' + path.split('/').map(encodeURIComponent).join('/');
      // Basic Auth
      const auth = 'Basic ' + Pure.b64enc(p.username + ':' + p.password);
      const headers = {
        'Authorization': auth,
        'Content-Type': 'text/markdown;charset=UTF-8',
      };
      // PUT 上传（覆盖已存在文件）
      const r = await GM.request({ method: 'PUT', url: fullUrl, headers, data: rendered.full });
      if (r.status < 200 || r.status >= 300) {
        throw new Error('WebDAV 写入失败: HTTP ' + r.status + ' ' + ((r.responseText || '').slice(0, 400)));
      }
      return { ok: true, path, via: 'webdav' };
    },
  };

  // ============================================================
  // §7  SERVICES — Translate (Edge / Tencent / Ali)
  // ============================================================
  Services.Translate = {
    _uuid() {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    },
    _unescapeHtml(s) {
      try {
        const div = document.createElement('div');
        div.innerHTML = s || '';
        return div.textContent || '';
      } catch (e) { return s || ''; }
    },
    // Edge: https://edge.microsoft.com/translate/translatetext (no auth, anon)
    // body 为字符串数组 [text](不是 [{"Text":...}]),from/to 用 639-1 代码,isEnterpriseClient=false
    async edge(text, from, to) {
      const url = 'https://edge.microsoft.com/translate/translatetext?from=' +
        encodeURIComponent(from === 'auto' ? '' : from) +
        '&to=' + encodeURIComponent(to) +
        '&isEnterpriseClient=false';
      const r = await GM.request({
        method: 'POST', url,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        data: JSON.stringify([text]),
        responseType: 'text',
      });
      let j = null;
      try { j = JSON.parse(r.responseText || ''); } catch (e) { /* ignore */ }
      if (!j || !j[0] || !j[0].translations || !j[0].translations[0]) {
        throw new Error('edge: bad response');
      }
      return this._unescapeHtml(j[0].translations[0].text);
    },
    // Tencent interactive (free anonymous endpoint, client_key 需带随机 uuid)
    async tencent(text, from, to) {
      const ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : '';
      const cv = (ua.match(/Chrome\/(\d+)/) || [, '120'])[1];
      const body = {
        header: { fn: 'auto_translation', session: '', client_key: 'browser-chrome-' + cv + '-Windows_10-' + this._uuid() + '-' + Date.now(), user: '' },
        type: 'plain', model_category: 'normal', text_domain: 'general',
        source: { lang: from === 'auto' ? 'auto' : from, text_list: [text] },
        target: { lang: to },
      };
      const r = await GM.request({
        method: 'POST', url: 'https://transmart.qq.com/api/imt',
        headers: { 'Content-Type': 'application/json', 'Origin': 'https://transmart.qq.com', 'Referer': 'https://transmart.qq.com/' },
        data: JSON.stringify(body), responseType: 'json',
      });
      const j = r.response || (r.responseText ? JSON.parse(r.responseText) : null);
      const t = (j && j.target && j.target.text_list && j.target.text_list[0]) ||
                (j && j.auto_translation && j.auto_translation[0]) ||
                (j && j.data && j.data[0] && j.data[0].trans_text);
      if (!t) throw new Error('tencent: bad response');
      return t;
    },
    // Alibaba: https://translate.alibaba.com/api/translate/text
    // 与可用参考脚本一致: csrftoken 鉴权 + multipart/form-data 提交
    _aliToken: null,
    _aliBoundary: (() => Array.from({ length: 16 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[(Math.random() * 62) | 0]).join(''))(),
    async _aliAuth() {
      if (this._aliToken) return;
      const resp = await GM.request({ method: 'GET', url: 'https://translate.alibaba.com/api/translate/csrftoken', headers: { 'Accept': 'application/json' } });
      if (!resp || resp.status !== 200) throw new Error('阿里 csrftoken 请求失败');
      let j = null;
      try { j = JSON.parse(resp.responseText || ''); } catch (e) { /* ignore */ }
      this._aliToken = (j && j.token) || null;
      if (!this._aliToken) throw new Error('阿里鉴权失败');
    },
    _aliBuildBody(srcLang, tgtLang, text) {
      const b = '------WebKitFormBoundary' + this._aliBoundary;
      const field = (name, val) => b + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + val + '\r\n';
      return field('srcLang', srcLang) + field('tgtLang', tgtLang) + field('domain', 'general') + field('query', text) + field('_csrf', this._aliToken) + b + '--\r\n';
    },
    async ali(text, from, to) {
      await this._aliAuth();
      if (!this._aliToken) throw new Error('阿里鉴权失败');
      const resp = await GM.request({
        method: 'POST', url: 'https://translate.alibaba.com/api/translate/text',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=----WebKitFormBoundary' + this._aliBoundary,
          'Origin': 'https://translate.alibaba.com', 'Referer': 'https://translate.alibaba.com/',
          'x-xsrf-token_property_item': this._aliToken,
        },
        data: this._aliBuildBody(from === 'auto' ? 'auto' : from, to, text),
      });
      let j = null;
      try { j = JSON.parse(resp.responseText || ''); } catch (e) { /* ignore */ }
      if (!j) throw new Error('ali: bad response');
      const t = (j.data && j.data.translateText) || j.successText || '';
      if (!t) throw new Error('ali: bad response');
      return t;
    },
    // ---- 翻译缓存（内存 LRU + GM 持久化，800ms 防抖写回） ----
    // 已翻译过的文本不再重复请求：整页翻译 取消→再翻、划词重复选中 都直接命中。
    _cache: new Map(),
    _cacheMax: 1500,
    _cacheLoaded: false,
    _cacheDirty: false,
    _cacheTimer: null,
    _loadCache() {
      this._cacheLoaded = true;
      try {
        const raw = Storage.get('transCache', null);
        if (raw && typeof raw === 'object') this._cache = new Map(Object.entries(raw));
      } catch (e) { /* ignore */ }
    },
    _flushCache() {
      this._cacheDirty = false;
      if (this._cacheTimer) { clearTimeout(this._cacheTimer); this._cacheTimer = null; }
      try { Storage.set('transCache', Object.fromEntries(this._cache)); } catch (e) { /* ignore */ }
    },
    _cachePut(key, val) {
      if (this._cache.size >= this._cacheMax) {
        // 简单 FIFO 淘汰：删除最早插入的 200 条
        const it = this._cache.keys();
        for (let i = 0; i < 200; i++) {
          const n = it.next();
          if (n.done) break;
          this._cache.delete(n.value);
        }
      }
      this._cache.set(key, val);
      this._cacheDirty = true;
      if (this._cacheTimer) clearTimeout(this._cacheTimer);
      this._cacheTimer = setTimeout(() => this._flushCache(), 800);
    },
    _cacheKey(text, provider, target) {
      return Pure.hash(String(text == null ? '' : text)) + '|' + provider + '|' + (target || '');
    },
    async oneShot(text, from, to) {
      if (Pure.shouldSkip(text, to)) return text;
      const p = Config.data.translate.provider;
      // AI 内部还分 openai / anthropic，key 里带上以免混用译文
      const key = this._cacheKey(text, p === 'ai' ? 'ai:' + ((Services.AI._resolve('translate') || {}).service || {}).name || 'ai' : p, to);
      if (!this._cacheLoaded) this._loadCache();
      if (this._cache.has(key)) return this._cache.get(key);
      let out;
      if (p === 'tencent') out = await this.tencent(text, from, to);
      else if (p === 'ali') out = await this.ali(text, from, to);
      else if (p === 'ai') out = await Services.AI.translateText(text, to);
      else out = await this.edge(text, from, to);
      if (out && String(out).trim()) this._cachePut(key, out);
      return out;
    },
  };
  // ============================================================
  // §8  SERVICES — AI (OpenAI / Anthropic compatible, streaming)
  // ============================================================
  Services.AI = {
    // 通用 SSE 流式请求：处理 GM_xmlhttpRequest + 行缓冲 + 错误处理
    _resolve(ref) {
      const cfg = Config.data.ai || {};
      const services = cfg.services || [];
      let name = '';
      if (ref === 'chat') name = cfg.chatService;
      else if (ref === 'translate') name = (Config.data.translate || {}).aiService;
      else if (ref === 'selection') name = (Config.data.selection || {}).aiService;
      const service = services.find(s => s.name === name) || services[0] || {};
      return { service, model: service.model || '' };
    },
    _sseStream({ url, headers, body, onDelta, parseDelta, signal }) {
      return new Promise((resolve, reject) => {
        let buf = '';
        let pending = '';
        let done = false;
        const finish = (err, val) => {
          if (done) return;
          done = true;
          try { xhr.abort(); } catch (e) { /* ignore */ }
          if (err) reject(err); else resolve(val);
        };
        const handleLines = (src, isFinal) => {
          pending += src;
          let lines = pending.split(/\r?\n/);
          if (!isFinal) pending = lines.pop(); else { pending = ''; }
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            if (payload === '[DONE]') { finish(null, ''); return; }
            try {
              const j = JSON.parse(payload);
              const r = parseDelta ? parseDelta(j) : null;
              if (r && r.done) { finish(null, ''); return; }
              if (r && r.delta) onDelta && onDelta(r.delta);
            } catch (e) { console.warn('[orb] SSE parse error:', e); }
          }
        };
        const xhr = GM_xmlhttpRequest({
          method: 'POST', url, headers, data: body,
          responseType: 'text', timeout: 60000,
          onprogress(resp) {
            const text = resp.responseText;
            if (!text) return;
            const chunk = text.slice(buf.length);
            buf = text;
            if (chunk) handleLines(chunk, false);
          },
          onload(resp) {
            if (resp.responseText && resp.responseText.length > buf.length) {
              handleLines(resp.responseText.slice(buf.length), true);
            } else if (pending) { handleLines('', true); }
            finish(null, '');
          },
          onerror(e) { finish(new Error('AI stream error: ' + (e && e.error || 'unknown'))); },
          ontimeout() { finish(new Error('AI stream timeout')); },
        });
        if (signal) signal.addEventListener('abort', () => finish(new Error('aborted')));
      });
    },

    _openaiStream({ baseURL, apiKey, model, messages, signal, onDelta, enableSearch }) {
      const url = (baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions';
      const payload = { model, messages, stream: true, temperature: 0.4 };
      if (enableSearch) payload.tools = [{ type: 'web_search', web_search: { enable: true } }];
      return this._sseStream({
        url,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey, 'Accept': 'text/event-stream' },
        body: JSON.stringify(payload),
        signal, onDelta,
        parseDelta: (j) => {
          const d = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          return d ? { delta: d } : null;
        },
      });
    },
      _anthropicStream({ baseURL, apiKey, model, system, messages, signal, onDelta, enableSearch }) {
      const base = (baseURL || 'https://api.anthropic.com').replace(/\/+$/, '');
      const url = base.endsWith('/v1') ? base + '/messages' : base + '/v1/messages';
      const payload = {
        model, system: system || '', messages,
        max_tokens: 2048, stream: true, temperature: 0.4,
      };
      if (enableSearch) payload.tools = [{ type: 'web_search_20260209', name: 'web_search' }];
      return this._sseStream({
        url,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(payload),
        signal, onDelta,
        parseDelta: (j) => {
          if (j.type === 'content_block_delta' && j.delta && j.delta.text) return { delta: j.delta.text };
          if (j.type === 'message_stop') return { done: true };
          return null;
        },
      });
    },
    
    chatStream({ messages, system, onDelta, signal, ref }) {
      const { service: s, model } = this._resolve(ref || 'chat');
      const enableSearch = !!s.enableSearch;
      if (s.kind === 'anthropic') {
        return this._anthropicStream({
          baseURL: s.baseURL, apiKey: s.apiKey, model,
          system, messages, signal, onDelta, enableSearch,
        });
      }
      return this._openaiStream({
        baseURL: s.baseURL, apiKey: s.apiKey, model,
        messages: (system ? [{ role: 'system', content: system }] : []).concat(messages || []),
        signal, onDelta, enableSearch,
      });
    },
    // 通用 AI 翻译：与对话共用同一 chatStream 通道（流式聚合），翻译/划词/对话三处可复用
    async translateText(text, target) {
      const langName = Pure.langName(target);
      const tpl = (Config.data.translate && Config.data.translate.aiPrompt) ||
        'You are a professional translation engine. Translate the user message into {{langName}}. Output ONLY the translation, no explanations, no quotes, no code fences.';
      const vars = Pure.getTemplateVars({ lang: target, langName: langName });
      const system = Pure.templateRender(tpl, vars);
      let out = '';
      await this.chatStream({
        system,
        messages: [{ role: 'user', content: String(text == null ? '' : text) }],
        onDelta: (d) => { out += d; },
        ref: 'translate',
      });
      return (out || '').trim();
    },
  };

  // §10  SVG ICONS  (inline, no external)
  // ============================================================
  // lucide 风格图标:统一 24×24 viewBox、2px stroke、round cap/join,几何简洁。
  const Icons = (() => {
    // lucide 风格 SVG 骨架：所有图标共用同一视图框与描边参数
    const ic = (body) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
    return {
      // 主球:lucide Disc(实心圆点 + 外环)
      main: ic('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="2"/>'),
      // lucide ChevronUp
      chevronUp: ic('<path d="m18 15-6-6-6 6"/>'),
      // 翻页:lucide FileDown(文档 + 向下箭头)
      flip: ic('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/>'),
      // 记录:lucide NotebookPen(便签 + 笔)
      note: ic('<path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/>'),
      // 剪藏:lucide Bookmark(书签)
      clip: ic('<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>'),
      // 翻译:lucide Languages(文A ↔ 文)
      translate: ic('<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>'),
      // 对话:lucide MessageSquare(圆角气泡)
      chat: ic('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
      // 批注:lucide Highlighter(荧光笔高亮)
      annotate: ic('<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>'),
      // 划词:lucide TextCursorInput(文字光标)
      select: ic('<path d="M5 4h1a3 3 0 0 1 3 3 3 3 0 0 1 3-3h1"/><path d="M13 20h-1a3 3 0 0 1-3-3 3 3 0 0 1-3 3H5"/><path d="M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1"/><path d="M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7"/><path d="M9 7v10"/>'),
      // 搜索:lucide Search(放大镜)
      search: ic('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
    };
  })();
  // 图标缓存
  Icons._elCache = {};
  Icons.el = function(name) {
    if (!Icons._elCache[name] && Icons[name]) {
      const d = document.createElement('div');
      d.innerHTML = Icons[name];
      Icons._elCache[name] = d.firstChild;
    }
    return Icons._elCache[name] ? Icons._elCache[name].cloneNode(true) : null;
  };
  try { Object.freeze(Icons); } catch (e) { /* ignore */ };
  if (typeof globalThis !== 'undefined') globalThis.__ORB_ICONS__ = Icons;

  // ============================================================
  // §11  STYLE STRINGS  (全部注入到 document.head,主球和子球共用基础样式)
  // 主球 = .sub + .main-ball 修饰 (位置固定、idle 靠边隐藏弱化、hover/展开滑出、fab-expanded 旋转)
  // ============================================================

  const STYLE_BALL_GLOBAL = `
.orb-sub{position:fixed;width:32px;height:32px;border-radius:50%;background:#fff;color:#4b5563;display:flex;align-items:center;justify-content:center;cursor:pointer;pointer-events:auto;box-shadow:0 2px 8px rgba(0,0,0,.12);font-size:11px;user-select:none;opacity:0;transform:translateY(8px) scale(.85);transition:transform .22s cubic-bezier(.2,.8,.2,1),opacity .18s ease,background-color .15s ease,color .15s ease;z-index:2147483647;}
.orb-sub.show{opacity:1;transform:translateY(0) scale(1);}
.orb-sub:hover{transform:translateY(0) scale(1.08);}
.orb-sub svg{width:16px;height:16px;}
.orb-sub.busy{color:#fff;background:linear-gradient(135deg,var(--orb-primary,#5b6cff),var(--orb-primary-end,#8a5bff));animation:orb-pulse 1.2s ease-in-out infinite;}
.orb-sub.ok{background:linear-gradient(135deg,var(--orb-success,#19c37d),#5bff8a) !important;color:#fff;}
.orb-sub.err{background:linear-gradient(135deg,var(--orb-error,#ff4b4b),#ff6b6b) !important;color:#fff;}
/* 子球标签气泡:显示在子球左侧(屏幕左方向),hover 时出现 */
.orb-sub .orb-lbl{position:absolute;right:calc(100% + 8px);top:50%;transform:translateY(-50%);background:rgba(20,22,30,.92);color:#fff;padding:3px 8px;border-radius:8px;font-size:11px;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .15s ease;}
.orb-sub.orb-lbl-show .orb-lbl{opacity:1;}
/* === 主球修饰:复用 .orb-sub 基础样式,只改 idle 行为 + 不接受 hover scale + chevron 旋转 === */
.orb-sub.orb-main-ball{opacity:.35;transform:translateX(30%);box-shadow:0 2px 8px rgba(0,0,0,.12);transition:opacity .2s ease,transform .25s ease,box-shadow .18s ease,background-color .15s ease,color .15s ease;cursor:pointer;z-index:2147483647;}
.orb-sub.orb-main-ball:hover{opacity:1;transform:translateX(0);box-shadow:0 6px 20px rgba(0,0,0,.28);}
.orb-sub.orb-main-ball.orb-fab-expanded{opacity:1;transform:translateX(-6px);}
.orb-sub.orb-main-ball.orb-armed{background:linear-gradient(135deg,#ff8a5b,#ffb347);color:#fff;opacity:1;}
/* 主球的 fab-icon 旋转:收起时 ▲ 朝上(默认 chevronUp),展开时 180° 旋转变 ▼ 朝下 */
.orb-sub.orb-main-ball .orb-fab-icon{width:20px;height:20px;display:flex;align-items:center;justify-content:center;transition:transform .2s ease;}
.orb-sub.orb-main-ball .orb-fab-icon svg{width:100%;height:100%;display:block;}
.orb-sub.orb-main-ball.orb-fab-expanded .orb-fab-icon{transform:rotate(180deg);}
.orb-search-pop{position:fixed;display:flex;flex-direction:row;flex-wrap:nowrap;gap:6px;padding:0;background:transparent;pointer-events:auto;opacity:0;transform:translateX(6px) scale(.95);transition:opacity .18s ease,transform .18s ease;z-index:2147483647;max-width:calc(100vw - 90px);overflow-x:auto;overflow-y:hidden;scrollbar-width:none;}
.orb-search-pop::-webkit-scrollbar{display:none;}
.orb-search-pop.show{opacity:1;transform:translateX(0) scale(1);}
.orb-search-pop .orb-eng{width:32px;height:32px;border-radius:50%;background:#fff;color:#4b5563;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:12px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,.12);transition:transform .22s cubic-bezier(.2,.8,.2,1),background-color .15s ease,color .15s ease;}
.orb-search-pop .orb-eng:hover{transform:translateY(0) scale(1.08);background:#5b6cff;color:#fff;}
.orb-input{position:fixed;z-index:2147483647;}
.orb-input textarea{width:100%;min-height:90px;border:1px solid #d1d5db;border-radius:8px;padding:6px 8px;font-size:13px;resize:vertical;font-family:inherit;background:#fff;color:#222;}
.orb-trans-line{color:#6b7280;font-size:.92em;line-height:1.5;margin-top:4px;}
@keyframes orb-pulse{0%,100%{box-shadow:0 0 0 0 rgba(91,108,255,.45),0 4px 14px rgba(0,0,0,.18);}50%{box-shadow:0 0 0 8px rgba(91,108,255,0),0 4px 18px rgba(0,0,0,.22);}}


@media (prefers-color-scheme: dark){
.orb-sub{background:#1d1f28;color:#c7ccd4;}
  .orb-sub.orb-main-ball{box-shadow:0 4px 14px rgba(0,0,0,.5);}
  .orb-sub.orb-main-ball:hover{box-shadow:0 6px 20px rgba(0,0,0,.6);}
  .orb-sub.orb-main-ball.orb-armed{color:#fff;}
  .orb-search-pop .orb-eng{background:#1d1f28;color:#c7ccd4;}
  .orb-input textarea{background:#0f1117;color:#e5e7eb;border-color:#2a2d3a;}
  .orb-trans-line{color:#9ca3af;}
}

.orb-sub:active{transform:scale(.92);}`;

  function injectGlobalStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('orb-global-styles')) return;
    const s = document.createElement('style');
    s.id = 'orb-global-styles';
    s.setAttribute('data-orb', 'global');
    s.textContent = STYLE_BALL_GLOBAL;
    (document.head || document.documentElement).appendChild(s);
  }

  const STYLE_PANEL = `
:host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;color-scheme:light dark;}
.wrap{position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:2147483647;}
.card{
  --bg:#ffffff;--bg2:#f6f7fb;--bg3:#fafbfc;--tx:#222;--muted:#666;
  --bd:#e4e7ec;--hover:#f2f4f7;--accent:#5b6cff;--err:#dc2626;--err-bg:#fee2e2;
  width:min(640px,90vw);max-height:80vh;background:var(--bg);color:var(--tx);
  border:1px solid var(--bd);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.28);
  display:flex;flex-direction:column;overflow:hidden;font-size:13px;
}
.hdr{padding:12px 16px;border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between;font-weight:600;font-size:14px;}
.hdr .x{cursor:pointer;font-size:16px;opacity:.5;border-radius:6px;padding:0 5px;line-height:1.4;}.hdr .x:hover{opacity:1;background:var(--hover);}
.body{padding:12px 16px;overflow:auto;display:flex;flex-direction:column;gap:12px;}
.section{border:1px solid var(--bd);border-radius:8px;padding:10px 12px;}
.section h4{margin:0 0 8px;font-size:13px;font-weight:600;color:var(--tx);display:flex;align-items:center;gap:6px;}
.row{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;}
  .lbl-top{align-self:flex-start;}
  .chk-lbl{display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;}
  .chk-lbl input{margin:0;}
  .ball-group{flex:1;display:flex;flex-wrap:wrap;gap:8px;}
  .path-hint{display:flex;align-items:center;gap:6px;font-size:12px;color:#888;}
  .inp-flex{flex:1;min-width:0;}
.row label{min-width:80px;font-size:12px;color:var(--muted);flex-shrink:0;}
.row input[type=text],.row input[type=password],.row select,.row textarea{flex:1;min-width:160px;height:28px;box-sizing:border-box;padding:4px 8px;border:1px solid var(--bd);border-radius:6px;font-size:12px;font-family:inherit;background:var(--bg);color:var(--tx);outline:none;transition:border-color .15s,box-shadow .15s;}
.row select{appearance:none;-webkit-appearance:none;padding-right:24px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23666' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 8px center;}
.row input:focus,.row select:focus,.row textarea:focus{border-color:var(--accent);box-shadow:0 0 0 2px rgba(91,108,255,.14);}
.row textarea{height:auto;min-height:72px;resize:vertical;line-height:1.5;}
.btn{display:inline-flex;align-items:center;justify-content:center;height:28px;box-sizing:border-box;padding:3px 12px;border:1px solid var(--bd);background:var(--bg);border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit;color:var(--muted);transition:background-color .15s,border-color .15s,color .15s;}
.btn:hover{background:var(--hover);color:var(--tx);}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;}
.btn.primary:hover{background:#4a5bf0;}
.btn.danger{color:var(--err);border-color:var(--err-bg);background:var(--bg);}
.btn.danger:hover{background:var(--err-bg);color:var(--err);}
.hint{font-size:11px;color:var(--muted);flex-basis:100%;}
.tag{display:inline-block;font-size:10px;color:var(--muted);background:var(--bg2);padding:1px 6px;border-radius:6px;cursor:pointer;user-select:none;}
.tag:hover{background:var(--hover);color:var(--accent);}
.list-item,.ai-svc,.pre-row,.eng-row{border:1px solid var(--bd);border-radius:8px;padding:8px 10px;margin:6px 0;background:var(--bg3);}

.li-top{display:flex;align-items:center;gap:6px;margin-bottom:6px;}
.li-top input[type=text]{flex:1;min-width:120px;height:28px;box-sizing:border-box;padding:4px 8px;border:1px solid var(--bd);border-radius:6px;font-size:12px;font-family:inherit;background:var(--bg);color:var(--tx);outline:none;transition:border-color .15s,box-shadow .15s;}
.li-top input:focus{border-color:var(--accent);box-shadow:0 0 0 2px rgba(91,108,255,.14);}
.li-top .btn{flex-shrink:0;}
.li-main{display:block;width:100%;box-sizing:border-box;height:28px;padding:4px 8px;border:1px solid var(--bd);border-radius:6px;font-size:12px;font-family:inherit;background:var(--bg);color:var(--tx);outline:none;transition:border-color .15s,box-shadow .15s;}
.li-main:focus{border-color:var(--accent);box-shadow:0 0 0 2px rgba(91,108,255,.14);}
textarea.li-main{height:auto;min-height:56px;resize:vertical;line-height:1.5;}
.ftr{padding:10px 16px;border-top:1px solid var(--bd);display:flex;justify-content:flex-end;gap:8px;background:var(--bg);}

@media (prefers-color-scheme: dark){
.card{--bg:#1b1e26;--bg2:#20242f;--bg3:#161922;--tx:#e6e8ee;--muted:#9aa1af;--bd:#2e333f;--hover:#262b36;--err:#ff8f8f;--err-bg:rgba(240,90,90,.16);box-shadow:0 16px 48px rgba(0,0,0,.5);}
}

.btn:active,.tag:active{transform:scale(.96);opacity:.85;}`;

  const STYLE_INPUT = `
:host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;color-scheme:light dark;}
.wrap{
  --bg:#ffffff;--bg2:#f6f7fb;--tx:#222;--muted:#666;
  --bd:#e4e7ec;--hover:#f2f4f7;--accent:#5b6cff;
  position:fixed;width:min(300px,85vw);max-height:min(380px,68vh);min-width:240px;
  display:flex;flex-direction:column;overflow:hidden;z-index:2147483647;
  border:1px solid var(--bd);border-radius:12px;background:var(--bg);color:var(--tx);
  box-shadow:0 8px 24px rgba(0,0,0,.14);font-size:13px;
}
.hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--bd);cursor:move;}
.hdr .t{font-weight:600;font-size:12px;color:var(--tx);flex:1;}
.hdr .actions{display:flex;align-items:center;gap:2px;}
.icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:none;background:transparent;color:var(--muted);cursor:pointer;border-radius:6px;transition:background .15s,color .15s;padding:0;}
.icon-btn:hover{background:var(--hover);color:var(--tx);}
.icon-btn svg{width:14px;height:14px;}
.body{flex:1;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px;min-height:0;}
.quote{border-left:3px solid #c7d2fe;background:var(--bg2);border-radius:6px;padding:7px 9px;max-height:120px;overflow:auto;}
.quote .q-body{font-size:12px;line-height:1.5;color:var(--muted);white-space:pre-wrap;word-wrap:break-word;}
textarea{flex:1;min-height:80px;border:1px solid var(--bd);border-radius:8px;padding:7px 9px;font-size:13px;line-height:1.5;resize:vertical;font-family:inherit;background:var(--bg);color:var(--tx);outline:none;transition:border-color .15s,box-shadow .15s;}
textarea:focus{border-color:var(--accent);box-shadow:0 0 0 2px rgba(91,108,255,.14);}
.ftr{padding:8px 10px;display:flex;justify-content:flex-end;gap:8px;}
.ftr .b{padding:5px 12px;border:1px solid var(--bd);background:var(--bg);border-radius:8px;cursor:pointer;font-size:12px;font-family:inherit;color:var(--muted);transition:background-color .15s,border-color .15s,color .15s;}
.ftr .b:hover{background:var(--hover);color:var(--tx);}
.ftr .b.primary{background:var(--accent);border-color:var(--accent);color:#fff;}
.ftr .b.primary:hover{background:#4a5bf0;}
.rz{position:absolute;right:2px;bottom:2px;width:14px;height:14px;cursor:se-resize;z-index:40;}
.rz::after{content:"";position:absolute;right:3px;bottom:3px;width:7px;height:7px;border-right:2px solid rgba(120,130,150,.5);border-bottom:2px solid rgba(120,130,150,.5);border-radius:0 0 2px 0;}
.rz:hover::after{border-color:var(--accent);}

@media (prefers-color-scheme: dark){
.wrap{--bg:#1b1e26;--bg2:#20242f;--tx:#e6e8ee;--muted:#9aa1af;--bd:#2e333f;--hover:#262b36;box-shadow:0 8px 24px rgba(0,0,0,.3);}
textarea{background:#14161d;border-color:#333947;}
textarea:focus{border-color:#6a85ff;box-shadow:0 0 0 2px rgba(106,133,255,.18);}
.quote{background:var(--bg2);border-color:#3d4a70;}
.ftr .b{background:#14161d;color:#c8cdd9;border-color:#333947;}
.ftr .b:hover{background:#1f232e;}
}
@media (max-width:768px){
  .wrap{width:min(300px,82vw);min-width:0;max-height:min(360px,65vh);}
}

.icon-btn:active,.b:active{transform:scale(.94);opacity:.85;}`;

  const STYLE_DIALOG = `
:host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;color-scheme:light dark;}
.wrap{
  --bg:#ffffff;--bg2:#f6f7fb;--bg3:#f6f7fb;--tx:#222;--muted:#666;
  --bd:#e4e7ec;--hover:#f2f4f7;--accent:#5b6cff;--user-bg:#eef3fb;
  --err-bg:rgba(220,50,47,.12);--err:#e34b4b;
  position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
}
@media (prefers-color-scheme: dark) {
  .wrap{
    --bg:#1e1f22;--bg2:#2a2b2f;--bg3:#2a2b2f;--tx:#e4e6eb;--muted:#9ca3af;
    --bd:#3a3b40;--hover:#35363b;--accent:#7c8cff;--user-bg:#2a3450;
    --err-bg:rgba(220,50,47,.2);--err:#ff6b6b;
  }
}
.wrap{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
  width:min(360px,88vw);max-height:min(480px,78vh);min-width:280px;
  display:flex;flex-direction:column;overflow:hidden;z-index:2147483647;
  border:1px solid var(--bd);border-radius:12px;background:var(--bg);color:var(--tx);
  box-shadow:0 20px 60px rgba(15,23,42,.35);font-size:14px;
}
.hdr{position:relative;display:flex;align-items:center;gap:6px;padding:10px 12px;border-bottom:1px solid var(--bd);cursor:move;}
.hdr .t{flex:1;min-width:0;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.hdr .actions{display:flex;align-items:center;gap:4px;flex-shrink:0;}
.icon-btn{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--muted);cursor:pointer;transition:background-color .15s,color .15s;}
.icon-btn:hover{background:var(--hover);color:var(--tx);}
.icon-btn svg{width:16px;height:16px;}
.icon-btn.model{display:flex;align-items:center;gap:5px;width:auto;min-width:64px;max-width:190px;height:28px;padding:0 9px;border:1px solid var(--bd);border-radius:8px;background:transparent;color:var(--tx);font-size:12px;font-family:inherit;cursor:pointer;transition:background-color .15s,border-color .15s,color .15s;}
.icon-btn.model .lbl{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.icon-btn.model:hover{background:var(--hover);color:var(--tx);}
/* 模型菜单（参考脚本 tp-model-menu） */
.mm{position:absolute;bottom:calc(100% + 4px);right:8px;width:min(264px,84vw);max-height:min(340px,60vh);overflow:auto;padding:6px 0;display:none;z-index:30;background:var(--bg);border:1px solid var(--bd);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.28);}
.mm.show{display:block;}
.mm-item{display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;min-height:38px;padding:6px 12px;border:0;background:transparent;color:var(--tx);text-align:left;cursor:pointer;font-size:13px;font-family:inherit;line-height:1.4;}
.mm-item:hover{background:var(--hover);}
.mm-item .lbl{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mm-item .ck{color:#32bd5b;visibility:hidden;flex-shrink:0;}
.mm-item.sel .ck{visibility:visible;}
.mm-sep{height:1px;margin:4px 0;background:var(--bd);}
.mm-label{padding:5px 12px 3px;font-size:11px;color:var(--muted);}
/* footer 附加区（参考 footer chip） */
.icon-btn.on{color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);}
/* 提示词胶囊条（统一对话/划词提示词，横向平铺） */
.preset-bar{display:flex;gap:5px;flex-wrap:wrap;align-items:center;padding:4px 6px;}
.ftr .preset-bar{padding-bottom:2px;}
.preset-bar .pc{padding:3px 10px;border:1px solid var(--bd);border-radius:12px;background:var(--bg);color:var(--tx);font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;transition:background-color .15s,color .15s,border-color .15s;}
.preset-bar .pc:hover{background:var(--hover);}
.pc.active{background:var(--accent);color:#fff;border-color:var(--accent);}
.body{flex:1 1 auto;min-height:0;overflow:auto;padding:8px 10px 10px;display:flex;flex-direction:column;gap:10px;scrollbar-width:thin;scrollbar-color:var(--muted) transparent;}
/* 消息行：meta / 气泡 / 操作条（气泡 textContent 保持纯净） */
.row{display:flex;flex-direction:column;gap:4px;max-width:100%;}
.row.user{align-items:flex-end;}
.row.assistant{align-items:flex-start;}
.row .meta{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:11px;line-height:1.2;padding:0 2px;}
.row.user .meta{justify-content:flex-end;}
.row .meta .who{color:var(--muted);}
.row.assistant .meta .who{color:var(--tx);}
.row .meta .tm{opacity:.9;}
.msg{max-width:88%;padding:8px 10px;border-radius:8px;font-size:13px;line-height:1.5;word-wrap:break-word;white-space:pre-wrap;overflow-wrap:anywhere;}
.msg.user{background:var(--user-bg);color:var(--tx);}
.msg.assistant{background:transparent;color:var(--tx);padding:2px 4px;white-space:normal;} /* md 渲染态 */
.msg.assistant.err{white-space:pre-wrap;}
.msg h1,.msg h2,.msg h3,.msg h4{font-size:14px;font-weight:700;margin:8px 0 3px;line-height:1.4;}
.msg h1{font-size:16px;} .msg h2{font-size:15px;}
.msg pre{background:var(--bg2);border:1px solid var(--bd);border-radius:8px;padding:6px 8px;overflow:auto;font-size:12px;line-height:1.5;margin:4px 0;}
.msg code{background:var(--bg2);border:1px solid var(--bd);border-radius:4px;padding:0 4px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
.msg pre code{background:transparent;border:0;padding:0;}
.msg blockquote{border-left:3px solid var(--bd);margin:4px 0;padding:2px 8px;color:var(--muted);}
.msg a{color:var(--accent);text-decoration:none;}
.msg a:hover{text-decoration:underline;}
.msg ul,.msg ol{margin:4px 0;padding-left:20px;}
.msg li{margin:2px 0;}
.msg .md-line{margin:2px 0;}
.msg .md-gap{height:6px;}
.msg hr{border:0;border-top:1px solid var(--bd);margin:8px 0;}
.msg del{color:var(--muted);}
.msg.assistant.err{background:var(--err-bg);color:var(--err);border-radius:8px;padding:10px 12px;margin:0 4px;}
.msg.assistant.pending{color:var(--muted);padding:2px 4px;}
.msg.assistant.pending::before{content:"正在生成";}
.msg.assistant.pending::after{content:"…";animation:orb-blink 1s infinite;}
@keyframes orb-blink{50%{opacity:.25;}}
.row .ops{display:flex;gap:4px;color:var(--muted);opacity:0;transition:opacity .15s;padding:2px;}
.row:hover .ops{opacity:1;}
.row.user .ops{justify-content:flex-end;}
.row .ops button{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;}
.row .ops button:hover{background:var(--hover);color:var(--tx);}
.row .ops svg{width:15px;height:15px;}
.msg.system{align-self:center;background:var(--bg3);color:var(--muted);font-size:12px;border-radius:8px;padding:5px 10px;}
/* 欢迎页（参考脚本 tp-welcome） */
.welcome{display:flex;flex-direction:column;align-items:center;gap:4px;padding:30px 0 10px;text-align:center;pointer-events:none;}
.welcome .w-t{font-size:18px;font-weight:700;color:var(--tx);}
.welcome .w-s{font-size:12px;color:var(--muted);margin-top:8px;}
/* 消息编辑（参考脚本 tp-edit-area） */
.edit-wrap{display:flex;flex-direction:column;gap:6px;width:100%;box-sizing:border-box;}
.edit-area{width:100%;min-height:84px;max-height:220px;border:1px solid var(--bd);border-radius:7px;padding:8px;background:var(--bg2);color:var(--tx);font-size:13px;font-family:inherit;line-height:1.5;resize:vertical;outline:none;box-sizing:border-box;}
.edit-area:focus{border-color:var(--accent);}
.edit-btns{display:flex;gap:6px;justify-content:flex-end;}
.edit-btns button{padding:3px 10px;border:1px solid var(--bd);border-radius:6px;background:var(--bg2);color:var(--tx);font-size:12px;cursor:pointer;font-family:inherit;}
.edit-btns button:hover{background:var(--hover);}
/* 调整大小手柄 */
.rz{position:absolute;right:2px;bottom:2px;width:16px;height:16px;cursor:se-resize;z-index:40;}
.rz::after{content:"";position:absolute;right:4px;bottom:4px;width:8px;height:8px;border-right:2px solid rgba(120,130,150,.55);border-bottom:2px solid rgba(120,130,150,.55);border-radius:0 0 2px 0;}
.rz:hover::after{border-color:var(--accent);}
.ftr{position:relative;padding:8px 10px;border-top:1px solid var(--bd);background:var(--bg);display:flex;flex-direction:column;gap:5px;}
.input-wrap{display:flex;align-items:flex-end;gap:5px;padding:4px 4px 4px 9px;border:1px solid var(--bd);border-radius:8px;background:var(--bg2);transition:border-color .15s,box-shadow .15s;}
.input-wrap textarea{flex:1;height:28px;min-height:28px;max-height:140px;padding:7px 9px 7px 0;border:0;outline:0;resize:none;background:transparent;color:var(--tx);line-height:1.5;font-size:13px;font-family:inherit;scrollbar-width:none;}
.input-wrap:focus-within{border-color:var(--accent);box-shadow:0 0 0 2px rgba(91,108,255,.14);}
.input-wrap textarea::placeholder{color:var(--muted);}
.send-btn{display:grid;place-items:center;width:32px;height:32px;padding:0;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer;flex-shrink:0;transition:background-color .15s;}
.send-btn:hover{background:#4a5bf0;}
.send-btn svg{width:16px;height:16px;}
.send-btn.stop{background:var(--bg3);color:var(--muted);}
.send-btn.stop:hover{background:var(--hover);}

/* 手机端:面板贴底,适配键盘弹出 */
@media (max-width:768px){
  .wrap{width:min(340px,85vw);min-width:0;height:min(460px,75vh);}
}



.icon-btn:active,.pc:active,.mm-item:active{transform:scale(.96);opacity:.85;}`;

  const STYLE_TOAST = `
:host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;}
.t{position:fixed;top:24px;left:50%;transform:translateX(-50%) translateY(-4px);background:rgba(20,22,30,.92);color:#fff;padding:7px 14px;border-radius:999px;font-size:13px;opacity:0;transition:opacity .2s ease,transform .2s ease;z-index:2147483647;backdrop-filter:blur(6px);box-shadow:0 8px 24px rgba(0,0,0,.2);pointer-events:none;max-width:80vw;}
.t.show{opacity:1;transform:translateX(-50%) translateY(0);}
.t.success{background:rgba(30,120,60,.92);}
.t.error{background:rgba(180,40,40,.92);}
.t.info{background:rgba(20,22,30,.92);}
`;

  // (STYLE_TRANSLATE 已随划词面板删除 — 划词处理统一走对话面板 action 模式)


  // ============================================================
  // §12  TOAST  (top center)
  // ============================================================
  const Toast = {
    host: null,
    el: null,
    timer: null,
    ensure() {
      if (this.host) return;
      const { host, root } = Pure.createHost(STYLE_TOAST);
      this.host = host;
      const el = document.createElement('div');
      el.className = 't';
      root.appendChild(el);
      this.el = el;
      (document.body || document.documentElement).appendChild(this.host);
    },
    show(msg, ms, type) {
      this.ensure();
      this.el.className = 't';
      this.el.innerHTML = '<span class="msg"></span>';
      this.el.querySelector('.msg').textContent = msg;
      const t = type || 'info';
      this.el.classList.add(t);
      this.el.classList.add('show');
      if (this.timer) clearTimeout(this.timer);
      const dur = ms || (t === 'error' ? 3000 : 2000);
      this.timer = setTimeout(() => { this.el.classList.remove('show'); }, dur);
    },
  };

  // ============================================================
  // §13  INPUT PANEL  (note/annotate quick input, anchored near ball)
  // ============================================================
  const InputPanel = {
    host: null,
    root: null,
    ensure() {
      if (this.host) return;
      const { host, root } = Pure.createHost(STYLE_INPUT);
      this.host = host;
      this.root = root;
      const wrap = document.createElement('div');
      wrap.className = 'wrap';
      wrap.innerHTML = '<div class="hdr"><div class="t">记录</div><div class="actions"><button class="icon-btn x" data-act="close" title="关闭" aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div></div><div class="body"><div class="quote" style="display:none"><div class="q-body"></div></div><textarea placeholder="说点什么…"></textarea></div><div class="ftr"><span class="b" data-act="cancel">取消</span><span class="b primary" data-act="save">保存</span></div><div class="rz" data-act="rz" title="调整大小"></div>';
      this.root.appendChild(wrap);
      (document.body || document.documentElement).appendChild(this.host);
      // 拖拽移动 + 调整大小（只绑一次；open/hide 不重绑不清理）
      const hdr0 = wrap.querySelector('.hdr');
      if (hdr0) this._cleanupDrag = makeDraggable(wrap, hdr0);
      makeResizable(wrap, wrap.querySelector('.rz'));
    },
    open({ title, placeholder, anchor, onSave, onCancel, quote, trigger }) {
      this.ensure();
      if (this._cleanupOutside) { this._cleanupOutside(); this._cleanupOutside = null; }
      if (this._cleanupKeyboard) { this._cleanupKeyboard(); this._cleanupKeyboard = null; }
      const wrap = this.root.querySelector('.wrap');
      const ta = wrap.querySelector('textarea');
      // 恢复:同一 trigger 且面板被隐藏 → 保留用户输入内容
      const isRestore = this._trigger === trigger && wrap.style.display === 'none';
      const savedText = isRestore ? ta.value : '';
      this._trigger = trigger || null;   // 记录触发子球 id（子球 toggle 用）
      const h = wrap.querySelector('.hdr .t');
      h.textContent = title || '记录';
      ta.value = savedText;
      ta.placeholder = placeholder || '说点什么…';
      // 引用选中原文：超出 200 字符直接省略，不提供展开
      const qWrap = wrap.querySelector('.quote');
      const qBody = wrap.querySelector('.quote .q-body');
      const fullQ = quote && String(quote).trim() ? String(quote) : '';
      if (fullQ) {
        const QMAX = 200;
        qBody.textContent = fullQ.length > QMAX ? fullQ.slice(0, QMAX) + '…' : fullQ;
        qWrap.style.display = 'block';
      } else {
        qWrap.style.display = 'none';
        qBody.textContent = '';
      }
      const ax = anchor.x, ay = anchor.y;
      // 优先显示在锚点(触发它的子球)左侧;左侧放不下时翻转到右侧
      requestAnimationFrame(() => {
        // 面板在 rAF 执行前已被关闭/隐藏 → 跳过定位与键盘监听（防泄漏）
        if (wrap.style.display === 'none') return;
        const w = wrap.offsetWidth, h2 = wrap.offsetHeight;
        const pos = Pure.positionPanel(ax, ay, w, h2);
        wrap.style.left = pos.x + 'px';
        wrap.style.top = pos.y + 'px';
        this._cleanupKeyboard = Pure.keyboardAdapt(wrap);
      });
      const close = () => { ta.value = ''; wrap.style.display = 'none'; };
      this._wrap = wrap; // 供 Esc 统一关闭
      const handler = (ev) => {
        // 用 closest 命中按钮：点击按钮内 SVG 图标时 target 是 path/svg，dataset 为空
        const btn = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
        if (!btn || !btn.dataset) return;
        const act = btn.dataset.act;
        if (act === 'close' || act === 'cancel') {
          close();
          onCancel && onCancel();
        } else if (act === 'save') {
          const v = ta.value;
          close();
          onSave && onSave(v);
        }
      };
      wrap.onclick = handler;
      wrap.style.display = '';
      // 外部点击收起(保留内容,再次点击子球恢复)
      this._cleanupOutside = Pure.outsideClick(this.host, () => this.hide());
      setTimeout(() => ta.focus(), 30);
    },
    hide() {
      if (this._cleanupOutside) { this._cleanupOutside(); this._cleanupOutside = null; }
      if (this._cleanupKeyboard) { this._cleanupKeyboard(); this._cleanupKeyboard = null; }
      if (this._trigger === 'note' || this._trigger === 'annotate') clearBusy(this._trigger);
      if (this._wrap) this._wrap.style.display = 'none';
    },
  };

  // ============================================================
  // §15  AI DIALOG  (Shadow DOM, streaming)
  // ============================================================
  // AI 对话内联图标（参考脚本风格）
  const ICON_SEND = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 20.5 21 12 3 3.5v6.3L15 12 3 14.2z"/></svg>';
  const ICON_STOP = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
  const ICON_REGEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>';
  const ICON_DEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg>';
  const ICON_PAGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg>';
  const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>';
  // 面板拖拽移动（参考脚本窗口交互：header 拖动）。
  // 点击与拖拽分离：移动超过 4px 才视为拖拽——避免 preventDefault 吞掉标题栏内按钮的 click
  //（如关闭/模型按钮），也避免点按被误判为拖动；touch-action:none 防止移动端触摸被页面滚动抢占。
  function makeDraggable(wrap, handle) {
    if (!wrap || !handle) return;
    let sx = 0, sy = 0, ox = 0, oy = 0, on = false, raf = 0, dragged = false;
    handle.style.cursor = 'move';
    handle.style.touchAction = 'none';
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      sx = e.clientX; sy = e.clientY;
      const r = wrap.getBoundingClientRect();
      ox = r.left; oy = r.top;
      on = true; dragged = false;
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    handle.addEventListener('pointermove', (e) => {
      if (!on) return;
      if (!dragged && Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < 4) return;  // 点击阈值
      if (!dragged) { dragged = true; wrap.style.transform = 'none'; e.preventDefault(); }
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const w = wrap.offsetWidth, h = wrap.offsetHeight;
        const nx = Math.max(0, Math.min(window.innerWidth - w, ox + (e.clientX - sx)));
        const ny = Math.max(0, Math.min(window.innerHeight - h, oy + (e.clientY - sy)));
        wrap.style.left = nx + 'px';
        wrap.style.top = ny + 'px';
      });
    });
    const end = () => { on = false; };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    // 拖拽结束后派发的 click（目标是按下时的元素,如按钮）一律吞掉,避免误触。
    // dragged 不在此重置：click 事件与 pointerup 的派发时序不保证先于 setTimeout(0)，
    // 统一由 click 消费（pointerdown 时也会重置，保证下次点击正常）。
    handle.addEventListener('click', (e) => {
      if (dragged) { e.stopPropagation(); e.preventDefault(); dragged = false; }
    });
  }
  // 面板调整大小（右下角手柄）
  function makeResizable(wrap, handle) {
    if (!wrap || !handle) return;
    let sx = 0, sy = 0, ow = 0, oh = 0, on = false;
    handle.style.touchAction = 'none';
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      on = true; sx = e.clientX; sy = e.clientY;
      ow = wrap.offsetWidth; oh = wrap.offsetHeight;
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!on) return;
      const w = Math.max(280, Math.min(ow + (e.clientX - sx), window.innerWidth - 16));
      const h = Math.max(200, Math.min(oh + (e.clientY - sy), window.innerHeight - 16));
      wrap.style.width = w + 'px';
      wrap.style.height = h + 'px';
      // 无条件清掉 max-height（含 CSS 的 max-height:min(...)），拉伸才不会被卡住；
      // 键盘弹出时 keyboardAdapt 会重新设回收缩值，收起后恢复到 baseMaxH。
      wrap.style.maxHeight = 'none';
      wrap.style.maxWidth = 'none';
    });
    const end = () => { on = false; };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  const AIDialog = {
    host: null,
    root: null,
    _wrap: null,        // 复用骨架（close 隐藏、open 显示，避免每次重建 DOM）
    _built: false,
    _fns: null,         // 首次构建时暴露的闭包函数（open 刷新用）
    _el: null,          // 首次构建时暴露的元素引用
    msgs: [],
    aborted: false,
    activeController: null,   // AbortController for the in-flight stream
    _lastPreset: 'You are a helpful assistant.',
    // 首次构建骨架 + 绑定事件（仅一次；open 每次只刷新状态/消息区）
    _ensureBuilt() {
      if (this._built && this.host) return;
      const { host, root } = Pure.createHost(STYLE_DIALOG);
      this.host = host;
      this.root = root;
      const wrap = document.createElement('div');
      wrap.className = 'wrap';
      wrap.innerHTML =
        '<div class="hdr">' +
          '<div class="t">对话</div>' +
          '<div class="actions">' +
            '<button class="icon-btn model" data-act="chip" title="切换模型"><span class="lbl">(未设置)</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>' +
            '<button class="icon-btn" data-act="toggle-page" title="附网页内容" aria-label="附网页内容">' + ICON_PAGE + '</button>' +
            '<button class="icon-btn" data-act="copy-all" title="复制全部对话" aria-label="复制全部对话">' + ICON_COPY + '</button>' +
            '<button class="icon-btn" data-act="new" title="新建会话" aria-label="新建会话"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>' +
            '<button class="icon-btn x" data-act="close" title="关闭" aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>' +
          '</div>' +
        '</div>' +
        '<div class="body"></div>' +
        '<div class="ftr">' +
          '<div class="preset-bar" data-act="preset-bar"></div>' +
          '<div class="input-wrap">' +
            '<textarea data-act="input" placeholder="开始提问"></textarea>' +
            '<button class="send-btn" data-act="send" title="发送" aria-label="发送">' + ICON_SEND + '</button>' +
          '</div>' +
          '<div class="mm" data-act="mm" role="menu"></div>' +
        '</div>' +
        '<div class="rz" data-act="rz" title="调整大小"></div>';
      this.root.appendChild(wrap);
      (document.body || document.documentElement).appendChild(this.host);
      // 面板拖拽（首次绑定一次；复用时不重复）
      const hdr = wrap.querySelector('.hdr');
      if (hdr) this._cleanupDrag = makeDraggable(wrap, hdr);
      makeResizable(wrap, wrap.querySelector('.rz'));
      const body = wrap.querySelector('.body');
      const input = wrap.querySelector('[data-act=input]');
      const sendBtn = wrap.querySelector('[data-act=send]');
      const chipBtn = wrap.querySelector('[data-act=chip]');
      const mm = wrap.querySelector('[data-act=mm]');
      const ctxBtn = wrap.querySelector('[data-act=toggle-page]');
      const closeBtn = wrap.querySelector('[data-act=close]');
      const newBtn = wrap.querySelector('[data-act=new]');
      const copyAllBtn = wrap.querySelector('[data-act=copy-all]');
      const presetBar = wrap.querySelector('[data-act="preset-bar"]');
      // 欢迎页（参考脚本 tp-welcome）：空会话提示（action 模式不显示）
      const welcome = document.createElement('div');
      welcome.className = 'welcome';
      welcome.innerHTML = '<div class="w-t">开始与 AI 对话吧！</div><div class="w-s">Enter 提交 · Shift+Enter 换行</div>';
      const escA = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      const self = this;
      // ---- 模型菜单（参考脚本 tp-model-menu）：只放服务/模型，提示词走胶囊条 ----
      function renderMm() {
        const services = (Config.data.ai && Config.data.ai.services) || [];
        const items = services
          .filter((s) => s.model)
          .map((s) => {
            const sel = (s.name === self._chatName) ? ' sel' : '';
            return '<button class="mm-item' + sel + '" data-m="' + escA(s.name) + '"><span class="lbl">' + escA(s.name + ' / ' + s.model) + '</span><span class="ck">✓</span></button>';
          })
          .join('');
        mm.innerHTML = items;
      }
      function hideMm() { mm.classList.remove('show'); }
      renderMm();
      // chip 打开/关闭菜单
      chipBtn.addEventListener('click', (e) => { e.stopPropagation(); mm.classList.toggle('show'); });
      // 点击菜单外关闭
      wrap.addEventListener('click', (e) => {
        // 点击消息区(.body)不关闭菜单(用户可能在选中文本);点其他区域才关闭
        if (!e.target.closest('[data-act="chip"]') && !e.target.closest('[data-act="mm"]') && !e.target.closest('.body')) hideMm();
      });
      // 菜单项：选择服务/模型
      mm.addEventListener('click', (e) => {
        const mi = e.target.closest('[data-m]');
        if (mi) {
          const svcName = mi.dataset.m || '';
          Config.data.ai.chatService = svcName;
          Config.save();
          const svc = (Config.data.ai.services || []).find((s) => s.name === svcName);
          self._chatName = svcName;
          self._curModel = (svc && svc.model) || '';
          const lbl = chipBtn.querySelector('.lbl');
          if (lbl) lbl.textContent = self._curModel || '(未设置)';
          renderMm();
          hideMm();
          return;
        }
      });
      // 新建会话（参考 openNewChat：清空消息与状态）
      newBtn.onclick = () => {
        if (self.activeController) { try { self.activeController.abort(); } catch (e) { /* ignore */ } self.activeController = null; }
        self.msgs = [];
        self._queue = [];
        self._turnText = {};
        self._aIdx = {};
        self._pendingContext = '';
        self._pendingEl = null;
        body.querySelectorAll('.row').forEach((r) => r.remove());
        if (self._mode !== 'action' && !welcome.parentNode) body.appendChild(welcome);
        input.value = '';
        input.placeholder = '开始提问';
        autoGrow();
        hideMm();
      };
      // 附网页内容 chip（参考 footer chip：开启后高亮；状态每次 open 时同步）
      ctxBtn.onclick = () => {
        const on = ctxBtn.classList.toggle('on');
        if (!!on !== !!Config.data.ai.includePageContent) Config.patch('ai.includePageContent', !!on);
      };
      // 关闭
      closeBtn.onclick = () => this.close();
      // enter：Enter 提交（Shift+Enter 换行）；Ctrl/Cmd+Enter 亦提交
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          if (e.shiftKey) return;                 // Shift+Enter 换行
          e.preventDefault();                     // Enter 提交（参考脚本交互）
          send();
        }
      });
      input.addEventListener('input', autoGrow);
      // 发送按钮：空闲=发送，生成中=停止（参考脚本 send/stop 切换）
      sendBtn.onclick = () => { if (sendBtn.classList.contains('stop')) stop(); else send(); };
      // 追加一条消息（参考脚本结构：meta 行 + 气泡 + hover 操作条），返回气泡元素供流式追加
      function appendMsg(role, text, opts) {
        if (opts && opts.hidden) return null;   // 参考脚本 hiddenUser：action 自动发送不渲染用户气泡，但 msgs 保留用于继续对话
        const row = document.createElement('div');
        row.className = 'row ' + role;
        if (role !== 'system') {
          const meta = document.createElement('div');
          meta.className = 'meta';
          const hm = new Date().toTimeString().slice(0, 5);
          if (role === 'user') {
            meta.innerHTML = '<span class="tm">' + hm + '</span>';
          } else {
            meta.innerHTML = '<span class="who"></span><span class="tm">' + hm + '</span>';
            meta.querySelector('.who').textContent = self._curModel || 'AI';  // textContent 防注入
          }
          row.appendChild(meta);
        }
        const bubble = document.createElement('div');
        bubble.className = 'msg ' + role;
        if (role === 'assistant') bubble.innerHTML = Pure.md(text);   // AI 回复渲染 md;user/system 保持纯文本防注入
        else bubble.textContent = text;
        row.appendChild(bubble);
        if (role !== 'system') {
          const ops = document.createElement('div');
          ops.className = 'ops';
          const b = (op, ic, t) => '<button data-op="' + op + '" title="' + t + '" aria-label="' + t + '">' + ic + '</button>';
          ops.innerHTML = role === 'user'
            ? b('copy', ICON_COPY, '复制')
            : b('copy', ICON_COPY, '复制') + b('edit', ICON_EDIT, '编辑') + b('regen', ICON_REGEN, '重新生成') + b('del', ICON_DEL, '删除');
          row.appendChild(ops);
        }
        if (role !== 'system' && welcome && welcome.parentNode) welcome.remove();
        body.appendChild(row);
        try { body.scrollTop = body.scrollHeight; } catch (e) { /* ignore */ }
        return bubble;
      }
      // 操作条事件委托：复制 / 重新生成 / 删除
      body.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('[data-op]') : null;
        if (!btn) return;
        const row = btn.closest('.row');
        const bubble = row && row.querySelector('.msg');
        if (!bubble) return;
        if (btn.dataset.op === 'copy') {
          copyText(bubble.textContent);
          Toast.show('已复制', 2000, 'success');
        } else if (btn.dataset.op === 'edit') {
          startEdit(bubble, row);
        } else if (btn.dataset.op === 'regen') {
          regenerate(row);
        } else if (btn.dataset.op === 'del') {
          deleteMsg(row);
        }
      });
      // 复制文本到剪贴板
      function copyText(t) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(t).catch(() => {});
        } else if (typeof GM_setClipboard === 'function') {
          GM_setClipboard(t);
        }
      }
      // 消息编辑（参考脚本 startEditMessage：气泡内 textarea + 保存/取消，保存后更新内容不重发）
      function startEdit(bubble, row) {
        if (bubble.querySelector('.edit-wrap')) return;
        const original = bubble.textContent;
        const wrap2 = document.createElement('div');
        wrap2.className = 'edit-wrap';
        wrap2.innerHTML = '<textarea class="edit-area"></textarea><div class="edit-btns"><button data-edit="save">保存</button><button data-edit="cancel">取消</button></div>';
        const ta = wrap2.querySelector('.edit-area');
        ta.value = original;
        bubble.textContent = '';
        bubble.appendChild(wrap2);
        ta.focus();
        wrap2.querySelector('[data-edit="save"]').onclick = () => {
          bubble.textContent = ta.value;
          const turn = Number(row.dataset.turn);
          const ai = self._aIdx[turn];
          if (ai != null && self.msgs[ai] && self.msgs[ai].role === 'assistant') self.msgs[ai].content = ta.value;
          Toast.show('已更新', 2000, 'success');
        };
        wrap2.querySelector('[data-edit="cancel"]').onclick = () => { bubble.textContent = original; };
      }
      // 全部对话转 Markdown（参考 conversationToMarkdown）
      function conversationToMarkdown() {
        const parts = ['# 对话\n'];
        self.msgs.forEach((m) => {
          if (m.role === 'system') return;
          const who = m.role === 'user' ? '用户' : (self._curModel || 'AI');
          parts.push('## ' + who + '\n\n' + (m.content || '') + '\n');
        });
        return parts.join('\n');
      }
      // 复制全部对话
      copyAllBtn.onclick = () => {
        const md = conversationToMarkdown();
        if (!md.trim()) { Toast.show('暂无对话内容'); return; }
        copyText(md);
        Toast.show('已复制全部', 2000, 'success');
      };
      // ---- 提示词胶囊条（统一对话/划词提示词，横向平铺；每次 open 重新渲染最新预设）----
      function renderPresetBar() {
        const bar = wrap.querySelector('[data-act="preset-bar"]');
        if (!bar) return;
        const presets = (Config.data.ai && Config.data.ai.presets) || [];
        const chips = [];
        presets.forEach((p) => {
          chips.push('<button class="pc" data-chip="preset" data-name="' + escA(p.name) + '" data-prompt="' + escA(p.prompt) + '" title="' + escA(p.name) + '">' + escA(p.name) + '</button>');
        });
        bar.innerHTML = chips.join('');
      }
      renderPresetBar();
      // （划词翻译引擎已移除：划词处理全部走 AI 提示词预设 / 继续对话）
      // 提示词胶囊：action（有选区）→ 直接发送；chat 输入框有内容 → 拼发送；否则填入输入框
      // 参考脚本：点按钮 = 新会话，丢弃之前的处理上下文（重新生成）
      function resetConversation() {
        if (self.activeController) { try { self.activeController.abort(); } catch (e) { /* ignore */ } self.activeController = null; }
        self.msgs = [];
        self._turnText = {};
        self._aIdx = {};
        self._pendingEl = null;
        [...body.querySelectorAll('.row')].forEach((r) => r.remove());
      }
      // 模板变量：统一用 Pure.templateRender + Pure.getTemplateVars
      function renderTemplate(tpl) {
        const selection = (self._seed || '').trim() || input.value.trim();
        const vars = Pure.getTemplateVars({
          selection: selection,
          pageContent: getPageSnippet(20000),
        });
        return Pure.templateRender(tpl, vars);
      }
      function onPresetChip(p, fromAuto) {
        self._lastPreset = p.prompt || '';
        // 激活态视觉反馈:当前选中的胶囊高亮
        try {
          presetBar.querySelectorAll('.pc').forEach((b) => b.classList.toggle('active', b.dataset.name === p.name));
        } catch (e) { /* ignore */ }
        const sel = self._seed || '';
        const ta = input.value.trim();
        if ((self._mode === 'action' && sel) || ta) {
          // 生成中点胶囊 = 新会话（chat 模式同样 abort 当前流，避免并发双流）
          if (self.activeController || (self._mode === 'action' && self.msgs.length > 0)) resetConversation();
          const tpl = p.prompt ? p.prompt : '';
          const selection = ta || sel;
          const vars = Pure.getTemplateVars({
            selection: selection,
            pageContent: getPageSnippet(20000),
          });
          const payload = Pure.templateRender(tpl, vars);
          doSend(payload, { hiddenUser: self._mode === 'action' });
          return;
        }
        input.value = renderTemplate(p.prompt || '');
        autoGrow();
        input.focus();
      }
      if (presetBar) {
        presetBar.addEventListener('click', (e) => {
          const c = e.target.closest('[data-chip]');
          if (!c) return;
          const presets = (Config.data.ai && Config.data.ai.presets) || [];
          const p = presets.find((x) => x.name === c.dataset.name) || null;
          if (p) onPresetChip(p);
        });
      }
      // 输入框自动增高（30–150px，参考脚本 autoGrowInput）
      function autoGrow() { Pure.autoGrow(input, 30, 150); }
      // 重新生成该轮回复：截断历史与 DOM，用原始提问重发（参考 regenerateMessage）
      function regenerate(row) {
        if (self.aborted || self.activeController) return;
        const turn = Number(row.dataset.turn);
        const orig = self._turnText[turn];
        if (!Number.isInteger(turn) || orig == null) return;
        self.msgs = self.msgs.slice(0, turn + 1);
        [...body.querySelectorAll('.row')].forEach((r) => {
          if (Number(r.dataset.turn) > turn) r.remove();
        });
        doSend(orig, { hiddenUser: !!(self.msgs[turn] && self.msgs[turn].hidden) });
      }
      // 删除最近一轮问答（参考 deleteMessage：删 assistant + 前一条 user）
      function deleteMsg(row) {
        const turn = Number(row.dataset.turn);
        if (!Number.isInteger(turn)) return;
        const hasLater = [...body.querySelectorAll('.row')].some((r) => Number(r.dataset.turn) > turn);
        if (hasLater) { Toast.show('只能删除最近一轮'); return; }
        if (self.activeController) return;
        const aIdx = self._aIdx[turn];
        self.msgs = self.msgs.filter((m, i) => !(i === turn && m.role === 'user') && !(aIdx != null && i === aIdx && m.role === 'assistant'));
        [...body.querySelectorAll('.row')].forEach((r) => {
          if (Number(r.dataset.turn) === turn) r.remove();
        });
        delete self._turnText[turn];
        delete self._aIdx[turn];
      }
      // 停止生成（参考 abortRequest）
      function stop() {
        if (!self.activeController) return;
        try { self.activeController.abort(); } catch (e) { /* ignore */ }
        self.activeController = null;
        const a = self._pendingEl;
        if (a) {
          a.classList.remove('pending');
          if (!a.textContent) a.textContent = '(已停止)';
        }
        finishTurn();
      }
      let scrollPending = false;
      function doSend(text, opts) {
        opts = opts || {};
        if (self.aborted) return;
        self._turnToken = (self._turnToken || 0) + 1;
        const myToken = self._turnToken;
        const include = ctxBtn.classList.contains('on');
        // 构建 system 上下文：提示词预设 + 选中内容 + 网页正文（用户消息保持纯净）
        const systemParts = [self._lastPreset || 'You are a helpful assistant.'];
        if (self._pendingContext) {
          systemParts.push('【选中内容】\n' + self._pendingContext);
          self._pendingContext = '';
        }
        if (include) {
          const ctx = getPageSnippet(20000);
          if (ctx) systemParts.push('【网页正文】\n' + ctx);
        }
        const system = systemParts.join('\n\n');
        const turn = self.msgs.length;
        self.msgs.push({ role: 'user', content: text, hidden: !!opts.hiddenUser });
        self._turnText[turn] = text;
        self._seed = '';
        // 发送后清除胶囊激活态(system prompt 已应用到本轮,视觉上重置)
        try { presetBar.querySelectorAll('.pc').forEach((b) => b.classList.remove('active')); } catch (e) { /* ignore */ }
        const uRow = appendMsg('user', text, { hidden: !!opts.hiddenUser });
        if (uRow) uRow.dataset.turn = turn;
        // sync "include page content" toggle back to Config (per-session override)
        if (!!include !== !!Config.data.ai.includePageContent) {
          Config.patch('ai.includePageContent', !!include);
        }
        // assistant placeholder + "正在生成…" 指示（参考 renderPendingStatus）
        const a = appendMsg('assistant', '');
        a.closest('.row').dataset.turn = turn;
        a.classList.add('pending');
        self._pendingEl = a;
        // 发送按钮 → 停止
        sendBtn.classList.add('stop');
        sendBtn.innerHTML = ICON_STOP;
        sendBtn.title = '停止';
        // stream — use a fresh AbortController so close()/stop() can cancel mid-flight
        const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        self.activeController = controller;
        // 历史裁剪：只发送最近 12 条消息
        const history = self.msgs.slice(-12);
        let firstDelta = true;   // 去掉首块 delta 的前导空白（OpenAI 兼容服务常先发换行）
        Services.AI.chatStream({
          system,
          messages: history,
          signal: controller ? controller.signal : null,
          onDelta: (d) => {
            if (self.aborted || myToken !== self._turnToken) return;
            if (a.classList.contains('pending')) { a.classList.remove('pending'); a.textContent = ''; }
            if (firstDelta) { d = String(d == null ? '' : d).replace(/^\s+/, ''); firstDelta = false; }
            if (d) a.textContent += d;
            if (!scrollPending) {
              scrollPending = true;
              requestAnimationFrame(() => {
                scrollPending = false;
                try { body.scrollTop = body.scrollHeight; } catch (e) { /* ignore */ }
              });
            }
          },
        }).then(() => {
          if (self.aborted || myToken !== self._turnToken) return;
          a.classList.remove('pending');
          a.innerHTML = Pure.md(a.textContent);
          self.msgs.push({ role: 'assistant', content: a.textContent });
          self._aIdx[turn] = self.msgs.length - 1;
          finishTurn();
        }).catch((e) => {
          if (self.aborted || myToken !== self._turnToken) return;
          a.classList.remove('pending');
          a.classList.add('err');
          a.textContent = '[错误]' + (e && e.message || e);
          finishTurn();
        });
      }
      function finishTurn() {
        self.activeController = null;
        self._pendingEl = null;
        sendBtn.classList.remove('stop');
        sendBtn.innerHTML = ICON_SEND;
        sendBtn.title = '发送';
        // 队列补发：发送中入队的消息依次自动发送
        const q = self._queue;
        if (q && q.length) {
          const next = q.shift();
          input.value = next;
          autoGrow();
          doSend(next);
        }
      }
      function send() {
        if (self.aborted) return;
        const text = input.value.trim();
        if (!text) { Toast.show('请输入内容'); return; }
        if (self.activeController) {
          // 发送锁 + 队列：回复中继续输入 → 入队,完成后自动补发（参考 chat 模式队列）
          const q = self._queue || (self._queue = []);
          q.push(text);
          Toast.show('已排队', 2000, 'info');
          input.value = '';
          autoGrow();
          return;
        }
        input.value = '';
        autoGrow();
        doSend(text);
      }
      // 暴露闭包给 open 复用（事件绑定保留在 _ensureBuilt 作用域内）
      this._wrap = wrap;
      this._built = true;
      this._fns = { renderMm, hideMm, appendMsg, copyText, startEdit, conversationToMarkdown, renderPresetBar, resetConversation, renderTemplate, onPresetChip, autoGrow, regenerate, deleteMsg, stop, doSend, finishTurn, send };
      this._el = { wrap, body, input, sendBtn, chipBtn, mm, ctxBtn, closeBtn, newBtn, copyAllBtn, welcome };
    },
    open(opts) {
      this.close();   // 隐藏 + 清运行态（保留 DOM）
      opts = opts || {};
      this._trigger = opts.trigger || null;   // 记录触发子球 id（子球 toggle 用）
      ensureClipLibs();   // 预热剪藏库(附网页上下文用;失败静默,不影响面板)
      const mode = opts.mode === 'action' ? 'action' : 'chat';   // 划词面板 = 对话面板的 action 形态
      const selSeed = opts.sel || opts.initialContext || '';
      this._ensureBuilt();
      const self = this;
      const { wrap, body, input, chipBtn, ctxBtn } = this._el;
      const { renderMm, hideMm, appendMsg, renderPresetBar, autoGrow, onPresetChip } = this._fns;
      // ---- 每次 open 刷新运行态 ----
      this.aborted = false;
      this._queue = [];
      this._turnToken = 0;
      this._pendingEl = null;
      const curSvcObj = (Services.AI._resolve('chat') || {}).service || {};
      this._chatName = curSvcObj.name || '';
      this._curModel = curSvcObj.model || '';
      this._mode = mode;
      // action(划词)总是新对话;chat 模式保留历史用于恢复显示
      if (mode === 'action' || opts.newChat || !this.msgs || !this.msgs.length) {
        this.msgs = [];
        this._turnText = {};
        this._aIdx = {};
        this._pendingContext = '';
      }
      this._seed = (mode === 'action') ? selSeed : '';  // chat 恢复时不用旧选区
      // 标题 + 模型标签 + 附网页开关
      wrap.querySelector('.hdr .t').textContent = mode === 'action' ? '划词' : '对话';
      const lbl = chipBtn.querySelector('.lbl');
      if (lbl) lbl.textContent = this._curModel || '(未设置)';
      ctxBtn.classList.toggle('on', !!Config.data.ai.includePageContent);
      renderMm();
      renderPresetBar();
      // 消息区重建（清空旧行 + welcome）
      [...body.querySelectorAll('.row')].forEach((r) => r.remove());
      if (this._el.welcome && this._el.welcome.parentNode) this._el.welcome.remove();
      // 输入区：重置 + initialContext / seed 处理
      input.value = '';
      input.placeholder = mode === 'action' ? '继续提问' : '开始提问';
      if (mode === 'action') {
        this._pendingContext = '';
      } else if (opts.initialContext) {
        appendMsg('system', '已载入上下文(' + (opts.initialContext.length) + ' 字符),请继续提问');
        input.value = '';
        this._pendingContext = opts.initialContext;
      } else if (opts.seed) {
        // 划词 → 继续对话：选中文本预填输入框,用户编辑/发送后进入对话
        input.value = opts.seed;
        this._pendingContext = '';
      } else {
        this._pendingContext = '';
      }
      // 恢复历史消息渲染(chat 模式 close 后再 open 保留对话)
      if (this.msgs && this.msgs.length) {
        this.msgs.forEach((m, idx) => {
          if (m.hidden) return;
          const row = appendMsg(m.role, m.content);
          if (!row) return;
          if (m.role === 'user') row.dataset.turn = idx;
          else {
            for (const [t, ai] of Object.entries(this._aIdx || {})) {
              if (Number(ai) === idx) { row.dataset.turn = t; break; }
            }
          }
        });
      } else if (mode !== 'action') {
        body.appendChild(this._el.welcome);
      }
      autoGrow();
      // 传入 anchor(触发它的子球)时,窗口优先显示在子球左侧;未传则保持原位/居中。
      // 定位放 rAF：display 恢复后再测量尺寸（复用时 display 还是 none,同步测量 offsetWidth=0 会定位错乱）
      if (opts.anchor) {
        const ax = opts.anchor.x, ay = opts.anchor.y;
        requestAnimationFrame(() => {
          // 面板在 rAF 执行前已被关闭 → 跳过定位
          if (wrap.style.display === 'none') return;
          const w = wrap.offsetWidth, h2 = wrap.offsetHeight;
          const pos = Pure.positionPanel(ax, ay, w, h2);
          wrap.style.transform = 'none';
          wrap.style.left = pos.x + 'px';
          wrap.style.top = pos.y + 'px';
        });
      } else {
        // 无锚点（快捷键/菜单打开）：居中显示（transform 由 keyboardAdapt 临时接管）
      }
      this._cleanupKeyboard = Pure.keyboardAdapt(wrap, '.body');
      wrap.style.display = '';
      // 划词面板融合：action 模式打开后自动执行默认动作
      if (mode === 'action' && opts.autoRun) {
        setTimeout(() => {
          if (!self.aborted && opts.autoRun !== 'none') {
            const presets = (Config.data.ai && Config.data.ai.presets) || [];
            const p = presets.find((x) => x.name === opts.autoRun);
            if (p) onPresetChip(p, true);
          }
        }, 80);
      }
      // 参考脚本 closeOnOutside：点击面板外部关闭（打开后短暂抑制，避免与触发点击冲突）
      self._cleanupOutside = Pure.outsideClick(this.host, () => { hideMm(); self.close(); });
    },
    close() {
      this.aborted = true;
      this._trigger = null;
      if (this._cleanupOutside) { this._cleanupOutside(); this._cleanupOutside = null; }
      if (this._cleanupKeyboard) { this._cleanupKeyboard(); this._cleanupKeyboard = null; }
      if (this.activeController) {
        try { this.activeController.abort(); } catch (e) { /* ignore */ }
        this.activeController = null;
      }
      if (this._wrap) this._wrap.style.display = 'none';
      // 保留 msgs/_turnText/_aIdx/_pendingContext 用于再次打开时恢复;只清运行时状态
      this._queue = [];
      this._pendingEl = null;
      this._turnToken = 0;
    },
    isOpen() { return !!(this.host && this._wrap && this._wrap.style.display !== 'none'); },
  };
  // 文章解析缓存：同一页面重复剪藏/附网页不再克隆+解析整个文档
  let _articleCache = null;
  let _articleCacheUrl = '';
  function cachedArticle() {
    try {
      if (_articleCacheUrl === location.href && _articleCache) return _articleCache;
      const doc = document.cloneNode(true);
      const imgs = doc.querySelectorAll('img');
      imgs.forEach((img) => {
        const resolved = Pure.resolveImgSrc(img);
        if (resolved) img.setAttribute('src', resolved);
      });
      _articleCache = new Readability(doc).parse();
      _articleCacheUrl = location.href;
      return _articleCache;
    } catch (e) { return null; }
  }
  function getPageSnippet(max) {
    try {
      const article = cachedArticle();
      let text = '';
      if (article && article.content && typeof TurndownService !== 'undefined') {
        try { text = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }).turndown(article.content); } catch (e) { /* ignore */ }
      }
      if (!text) text = (article && article.textContent) || document.body.innerText || '';
      return Pure.truncateByChars(text, max || 20000);
    } catch (e) {
      try { return Pure.truncateByChars(document.body.innerText || '', max || 20000); } catch (e2) { return ''; }
    }
  }

  // ============================================================
  // §16  PAGE TRANS  (immersive bilingual translation)
  // ============================================================
  const PageTrans = {
    active: false,
    observer: null,
    queue: [],
    concurrency: 6,
    processed: 0,
    aborted: false,
    _containerTags: new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TD', 'TH', 'CAPTION', 'FIGCAPTION']),
    _skipTags: new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'OPTION']),
    _walk(root) {
      // TreeWalker 原生遍历：替代手动递归（大页面扫描开销更低）
      const out = [];
      const acceptNode = (function (node) {
        if (this._skipTags.has(node.tagName)) return NodeFilter.FILTER_REJECT;   // 整棵子树跳过
        if (node.classList && (node.classList.contains('orb-skip') || node.classList.contains('orb-trans-block'))) return NodeFilter.FILTER_REJECT;
        if (this._containerTags.has(node.tagName)) {
          const txt = (node.textContent || '').trim();
          if (txt.length >= 2) {
            out.push(node);
            return NodeFilter.FILTER_REJECT;   // 容器块文本已计入，不再深入子节点
          }
        }
        return NodeFilter.FILTER_ACCEPT;
      }).bind(this);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, { acceptNode });
      while (walker.nextNode()) { /* 收集在 acceptNode 中完成 */ }
      return out;
    },
    async start() {
      if (this.active) return;
      this.active = true;
      this.aborted = false;
      this.processed = 0;
      this.queue = [];
      const target = Config.data.translate.target || 'zh';
      const blocks = this._walk(document.body);
      const todo = [];
      for (const b of blocks) {
        if (b.dataset && b.dataset.orbTrans) continue;
        if (b.dataset) b.dataset.orbTrans = '1';
        b.classList.add('orb-trans-block');
        // Skip if text already in target language
        const txt = (b.textContent || '').trim();
        if (Pure.shouldSkip(txt, target)) continue;
        todo.push({ el: b, text: txt, parent: b.parentElement || null });
      }
      // 合并同父相邻短块 → 一次请求翻译多段（译文注入父容器末尾）
      this.queue = this._group(todo);
      this._qIdx = 0;   // 出队游标：替代 queue.shift() 的 O(n²)
      // start a worker pool
      const workers = [];
      for (let i = 0; i < this.concurrency; i++) workers.push(this._worker(target));
      try {
        await Promise.all(workers);
      } finally {
        // 完成后复位：再次 start() 可重新扫描 SPA 动态加载的新内容
        // （已翻译块带 dataset.orbTrans 标记，不会重复翻译）
        this.active = false;
      }
    },
    // 贪心合并：连续、同父、短块（≤150 字符）累计 ≤1000 合成一组；
    // 译文注入父容器末尾，顺序按原文段落。父容器为 body/html 时不合并（避免译文落到页面底部）
    _group(todo) {
      const shortMax = 150, groupMax = 1000;
      const out = [];
      for (let i = 0; i < todo.length;) {
        const cur = todo[i];
        let j = i, total = cur.text.length;
        const group = [cur];
        const parent = cur.parent;
        // 仅连续短块合并：首块或后续任一块超过短块阈值即断开（防止长块并入组导致译文位置错乱）
        const canMerge = parent && parent.tagName !== 'BODY' && parent.tagName !== 'HTML' && cur.text.length <= shortMax;
        while (canMerge && j + 1 < todo.length) {
          const nx = todo[j + 1];
          if (nx.parent !== parent) break;
          if (nx.text.length > shortMax || total + nx.text.length > groupMax) break;
          total += nx.text.length;
          group.push(nx);
          j++;
        }
        if (group.length >= 2) {
          out.push({ el: parent, text: group.map((g) => g.text).join('\n'), merged: true });
        } else {
          out.push({ el: cur.el, text: cur.text });
        }
        i = j + 1;
      }
      return out;
    },
    async _worker(target) {
      while (!this.aborted) {
        const item = this.queue[this._qIdx++];
        if (!item) break;
        const text = (item.text || '').trim();
        if (!text) continue;
        try {
          if (this.aborted) return;
          // oneShot 内置缓存：取消后再翻译直接命中，不重复请求
          const tr = await Services.Translate.oneShot(Pure.truncateByChars(text, 1500), 'auto', target);
          if (this.aborted) return;
          this._injectTranslation(item.el, tr);
        } catch (e) {
          // soft-fail: a 429/rate-limit just skips this block, the next will retry
        }
      }
    },
    _injectTranslation(b, translation) {
      // remove previous
      const prev = b.querySelector('.orb-trans-line');
      if (prev) prev.remove();
      const line = document.createElement('div');
      line.className = 'orb-trans-line';
      line.textContent = translation;
      b.appendChild(line);
    },
    stop() {
      this.aborted = true;
      this.active = false;
      // remove translations
      try {
        document.querySelectorAll('.orb-trans-line').forEach((n) => n.remove());
        document.querySelectorAll('.orb-trans-block').forEach((n) => n.classList.remove('orb-trans-block'));
        document.querySelectorAll('[data-orb-trans]').forEach((n) => n.removeAttribute('data-orb-trans'));
      } catch (e) { /* ignore */ }
    },
    toggle() {
      if (this.active) this.stop(); else this.start();
    },
  };

  // §18  SEARCH POP  (left of ball, vertical, selection-only)
  // ============================================================
  const SearchPop = {
    host: null,
    show(anchor, engines, query) {
      this.hide();
      this._trigger = 'search';
      this.host = document.createElement('div');
      const root = this.host;
      const style = document.createElement('style');
      // inner pop pulls CSS from STYLE_BALL_GLOBAL injected into head
      style.textContent = '';
      root.appendChild(style);
      const pop = document.createElement('div');
      pop.className = 'orb-search-pop';
      engines.forEach((e) => {
        const d = document.createElement('div');
        d.className = 'orb-eng';
        d.textContent = e.name.charAt(0).toUpperCase();
        d.title = e.name;
        d.setAttribute('role', 'button');
        d.setAttribute('aria-label', '用 ' + e.name + ' 搜索');
        d.onclick = () => {
          // Replace %s 搜索词变量
          const url = String(e.url || '').replace(/%s/g, encodeURIComponent(query));
          window.open(url, '_blank');
          this.hide();
        };
        pop.appendChild(d);
      });
      root.appendChild(pop);
      (document.body || document.documentElement).appendChild(this.host);
      // 外部点击收起
      this._cleanupOutside = Pure.outsideClick(this.host, () => this.hide());
      // 横向排列在锚点(搜索子球)左侧
      const ax = anchor.x, ay = anchor.y;
      requestAnimationFrame(() => {
        const w = pop.offsetWidth, h = pop.offsetHeight;
        let tx = ax - 8 - w;
        if (tx < 8) tx = ax + 36;
        tx = Math.max(8, Math.min(FloatBtn.panelMaxRight() - w, tx));
        const ty = Math.max(8, Math.min(window.innerHeight - h - 8, ay - h / 2));
        pop.style.left = tx + 'px';
        pop.style.top = ty + 'px';
        pop.classList.add('show');
      });
    },
    hide() {
      if (this._cleanupOutside) { this._cleanupOutside(); this._cleanupOutside = null; }
      this._trigger = null;
      if (this.host) { this.host.remove(); this.host = null; }
    },
  };

  // ============================================================
  // §19  FLOAT BTN  (the 32px ball)
  // ============================================================
  const FloatBtn = {
    host: null,
    root: null,
    ball: null,
    _topPct: 0.45,
    _expand: false,
    ensure() {
      if (this.host) return;
      // 主球不再走 shadow DOM — 直接 append 到 document.body,跟子球共用 .sub 样式
      this.host = document.createElement('div');
      this.host.className = 'orb-root';
      this.host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
      const ball = document.createElement('div');
      ball.className = 'orb-sub orb-main-ball';
      ball.setAttribute('role', 'button');
      ball.setAttribute('aria-label', 'orb 悬浮球');
      ball.setAttribute('tabindex', '0');
      ball.innerHTML = '<span class="orb-fab-icon">' + Icons.chevronUp + '</span>';
      this.host.appendChild(ball);
      (document.body || document.documentElement).appendChild(this.host);
      this.ball = ball;
      this._topPct = (Config.data.ball && Config.data.ball.topPct) || 0.45;
      this._applyPos();
      this._bind();
    },
    _applyPos() {
      // 球永远贴右、不用 transform 偏移(避免影响 x() 与子球对齐);
      // 视觉上的"贴边感"交给 opacity: idle .5,hover/expanded 1。
      // 纵向由 _topPct 控制,运行时位置变更只能由 Panel 滑块触发。
      const edge = (Config.data.ball && Config.data.ball.edge) || 16;   // 离右边缘距离
      const x = window.innerWidth - edge;   // 球心 X
      const y = Math.max(20, Math.min(window.innerHeight - 20, window.innerHeight * this._topPct));
      this._topPct = y / window.innerHeight;
      this.ball.style.left = (x - 16) + 'px';   // 球左边 = innerWidth - 32
      this.ball.style.top = (y - 16) + 'px';
    },
    // 球的几何中心 (不用 getBoundingClientRect — 不受 transform 影响,稳定)
    x() {
      if (!this.ball) return window.innerWidth - 20;
      return parseInt(this.ball.style.left, 10) + 16;
    },
    y() {
      if (!this.ball) return window.innerHeight / 2;
      return parseInt(this.ball.style.top, 10) + 16;
    },
    // 悬浮球体系最左缘:主球左缘再往左 6px 子球左缘(edgeGap)
    leftEdge() { return this.x() - 22; },
    // 面板右缘上限:悬浮球最左缘再左 8px(展开的面板回避悬浮球,留边距)
    panelMaxRight() { return this.leftEdge() - 8; },
    contains(node) { return this.host && this.host.contains(node); },
    // 状态反馈统一在触发它的子球上(SubBalls.setState);
    // 主球只持有一个稳定的 chevron 图标,不再承担 busy/ok/err/playing 视觉。
    // 保留这个方法以兼容现有调用点 —— 内部委托给 SubBalls。
    setState(s, ms) {
      // active sub = 触发该 action 的子球
      if (SubBalls.activeSub) {
        const id = SubBalls.activeSub.dataset.actionId;
        if (id) SubBalls.setState(id, s, ms);
      }
      // 没有 active sub 时(很少见,如浮球内主动调用),主球不显示状态,no-op
    },
    arm(b) { this.ball && this.ball.classList.toggle('orb-armed', !!b); },
    runDoubleClickAction() {
      const id = (Config.data.ball && Config.data.ball.doubleClickAction) || 'note';
      if (Actions[id]) {
        try { Actions[id].call(Actions); } catch (e) { Pure.handleError(e); }
      }
    },
    _bind() {
      const b = this.ball;
      const self = this;
      const LONG_PRESS_MS = 500;

      // 单击 / 双击用 click + dblclick；长按单独计时（仅移动端有效，
      // 桌面端右键 = 长按，pointer/mouse 端 contextmenu 优先）。
      let pressTimer = null;
      let longPressFired = false;

      b.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        longPressFired = false;
        pressTimer = setTimeout(() => {
          longPressFired = true;
          try { Panel.open(); } catch (err) { /* ignore */ }
        }, LONG_PRESS_MS);
      });
      const cancelPress = () => {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      };
      b.addEventListener('pointerup', cancelPress);
      b.addEventListener('pointercancel', cancelPress);
      b.addEventListener('pointerleave', cancelPress);

      b.addEventListener('click', (e) => {
        // 长按触发了设置时不再 toggle
        if (longPressFired) { longPressFired = false; return; }
        // 鼠标右键 click 在某些浏览器里也会触发,过滤掉
        if (e.button !== undefined && e.button !== 0) return;
        e.stopPropagation();
        self._toggleExpand();
      });
      b.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        e.preventDefault();
        self.runDoubleClickAction();
      });
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        try { Panel.open(); } catch (err) { /* ignore */ }
      });
      // keyboard: Enter / Space toggle; 长按 = 设置走不到,只用 keydown
      b.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          self._toggleExpand();
        }
      });
    },
    _toggleExpand() {
      this._expand = !this._expand;
      this.ball.classList.toggle('orb-fab-expanded', this._expand);
      if (this._expand) {
        if (State.mode === 'global') SubBalls.showGlobal();
        else SubBalls.showSelection();
      } else {
        SubBalls.hide();
      }
    },
  };

  // ============================================================
  // §21  SUB BALLS  (cascading radial)
  // ============================================================
  const SubBalls = {
    list: [],
    _selTimer: null,
    initSelectionWatch() {
      const self = this;
      document.addEventListener('selectionchange', () => {
        if (self._selTimer) clearTimeout(self._selTimer);
        self._selTimer = setTimeout(() => self._checkSelection(), Config.data.selection.debounceMs || 300);
      });
    },
    _checkSelection() {
      const sel = window.getSelection && window.getSelection();
      if (!sel) return;
      if (sel.anchorNode) {
        let n = sel.anchorNode;
        while (n) {
          if (n.nodeType === 1 && ((n.id === 'orb-root') || (n.className && String(n.className).indexOf('orb-root') >= 0) || (n.getAttribute && n.getAttribute('data-orb-panel')))) return;
          n = n.parentNode;
        }
      }
      const text = String(sel.toString() || '').trim();
      const threshold = (Config.data.selection && Config.data.selection.threshold) || 2;
      const wantMode = text.length >= threshold ? 'selection' : 'global';
      if (wantMode === State.mode && text === State.selectionText) return;
      State.selectionText = text;
      State.mode = wantMode;
      FloatBtn._expand = true;
      FloatBtn.ball && FloatBtn.ball.classList.add('orb-fab-expanded');
      if (wantMode === 'selection') this.showSelection();
      else this.showGlobal();
    },
    activeSub: null,            // 当前正在执行业务的 sub 元素(用于 FloatBtn.setState 委托)
    GLOBAL: [
      { id: 'flip',      name: '翻页', icon: 'flip' },
      { id: 'note',      name: '记录', icon: 'note' },
      { id: 'clip',      name: '剪藏', icon: 'clip' },
      { id: 'translate', name: '翻译', icon: 'translate' },
      { id: 'chat',      name: '对话', icon: 'chat' },
    ],
    SELECTION: [
      { id: 'annotate',  name: '批注', icon: 'annotate' },
      { id: 'word',      name: '划词', icon: 'select' },
      { id: 'chat',      name: '对话', icon: 'chat' },
      { id: 'search',    name: '搜索', icon: 'search' },
    ],
    // 找到 id 对应的 sub DOM 元素
    _byId(id) {
      return this.list.find((el) => el.dataset.actionId === id) || null;
    },
    // 找到 id 对应子球的中心坐标(窗口类浮层锚定到子球用;元素不存在时返回 null)
    anchorOf(id) {
      const el = this._byId(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    // 给子球设状态 (busy/ok/err/playing/idle);ms 后回到 idle
    setState(id, state, ms) {
      const el = this._byId(id);
      if (!el) return;
      el.classList.remove('busy', 'ok', 'err', 'playing');
      if (state === 'busy' || state === 'playing' || state === 'ok' || state === 'err') {
        el.classList.add(state);
        if (ms) {
          setTimeout(() => {
            // 期间可能已切到别的状态,只在仍持有该 class 时清除
            if (el.classList.contains(state)) el.classList.remove(state);
          }, ms);
        }
      }
    },
    show(kind) {
      this.hide();
      const allDefs = (kind === 'global') ? this.GLOBAL : this.SELECTION;
      const enabled = (Config.data.balls && Config.data.balls[kind]) || allDefs.map(function(d){return d.id;});
      const defs = enabled.map(function(id){return allDefs.find(function(d){return d.id===id;});}).filter(Boolean);
      if (defs.length === 0) return;
      const ax = FloatBtn.x(), ay = FloatBtn.y();
      // 子球永远向上展开(简化设计,跟主球同 X 中心)
      const itemH = 32, gap = 8;
      // 展开态整体离右缘留 6px 间距(主球 fab-expanded 也左移 6px,二者对齐)
      const edgeGap = 6;
      // 第一个(最靠近主球)子球的 top edge: 主球上沿 - 子球高 - gap
      const firstTop = ay - 16 - 32 - 8;   // = ay - 56
      const stepY = itemH + gap;
      defs.forEach((d, i) => {
        const el = document.createElement('div');
        el.className = 'orb-sub';
        el.dataset.actionId = d.id;
        el.setAttribute('role', 'button');
        el.setAttribute('aria-label', d.name);
        el.setAttribute('tabindex', '0');
        el.innerHTML = (Icons[d.icon] || Icons.main) + '<span class="orb-lbl">' + d.name + '</span>';
        el.style.left = (ax - 16 - edgeGap) + 'px';
        el.style.top = (firstTop - i * stepY) + 'px';
        document.body.appendChild(el);
        this.list.push(el);
        setTimeout(() => el.classList.add('show'), i * 40);
        // 标签提示:本次展开内仅第一次悬浮时短暂显示 1.6s 后消失,后续悬浮不再显示
        // (子球每次展开都会重建,dataset 标记随之重置,即"每次展开重新生效")
        el.addEventListener('mouseenter', () => {
          if (el.dataset.lblShown) return;
          el.dataset.lblShown = '1';
          el.classList.add('orb-lbl-show');
          setTimeout(() => el.classList.remove('orb-lbl-show'), 1600);
        });
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this._onClick(d.id, el);
        });
        el.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            this._onClick(d.id, el);
          }
        });
      });
    },
    showGlobal() { this.show('global'); },
    showSelection() { this.show('selection'); },
    hide() {
      this.list.forEach((el) => el.remove());
      this.list = [];
      this.activeSub = null;
    },
    // 点击同一子球：面板已打开则收起，否则正常打开（记录/批注/对话/划词/搜索）
    _panelToggle(id) {
      const openPanel =
        (id === 'note' || id === 'annotate') ? !!(InputPanel.host && InputPanel._wrap && InputPanel._wrap.style.display !== 'none' && InputPanel._trigger === id)
        : (id === 'chat' || id === 'word') ? !!(AIDialog.host && AIDialog._trigger === id)
        : (id === 'search') ? !!(SearchPop.host && SearchPop._trigger === id)
        : false;
      if (!openPanel) return false;
      if (id === 'note' || id === 'annotate') InputPanel.hide();
      else if (id === 'chat' || id === 'word') AIDialog.close();
      else if (id === 'search') SearchPop.hide();
      return true;
    },
    async _onClick(id, el) {
      FloatBtn.arm(false);
      this.activeSub = el;
      if (this._panelToggle(id)) { this.activeSub = null; return; }   // 已开 → 收起
      if (isBusy() && !['translate', 'flip'].includes(id)) {
        this.setState(id, 'err', 1500);
        Toast.show('处理中…', 2000, 'info');
        this.activeSub = null;
        return;
      }
      this.setState(id, 'busy');
      try {
        if (Actions[id]) await Actions[id].call(Actions);
        this.setState(id, 'ok', 1500);
      } catch (e) {
        this.setState(id, 'err', 3000);
        Pure.handleError(e);
      } finally {
        this.activeSub = null;
      }
    },
  };

  // ============================================================
  // §22  ACTIONS  (one function per sub-ball)
  // ============================================================
  const Actions = {
    // 保存目标显示名
    _provName() {
      const p = (Config.data.notes && Config.data.notes.provider) || '';
      return ({ github: 'GitHub', gitee: 'Gitee', obsidian: 'Obsidian', webdav: 'WebDAV' })[p] || p;
    },
    // 通用执行包装：busy 状态 + 成功/失败反馈（note/annotate 的保存发生在 onSave 回调内，不传 okMsg）
    async _run(id, fn, okMsg) {
      if (!canStart(id)) { Toast.show('处理中…', 2000, 'info'); return; }
      setBusy(id);
      try {
        await fn();
        FloatBtn.setState('ok', 1500);
        if (okMsg) Toast.show(okMsg, 2000, 'success');
      } catch (e) {
        FloatBtn.setState('err', 3000);
        Pure.handleError(e);
      } finally {
        clearBusy(id);
      }
    },
    // --- Global ---
    async flip() {
      window.scrollBy(0, window.innerHeight);
      FloatBtn.setState('ok', 1200);
    },
    async note() {
      await this._run('note', () => {
        InputPanel.open({
          title: '记录',
          placeholder: '记录想法 / 速记 / TODO…',
          trigger: 'note',
          anchor: SubBalls.anchorOf('note') || { x: FloatBtn.x(), y: FloatBtn.y() },
          onSave: async (text) => {
            if (!text || !text.trim()) { clearBusy('note'); return; }
            try {
              const vars = Pure.getTemplateVars({
                comment: text,
                excerpt: (document.querySelector('meta[name=description]') || {}).content || '',
                author: (document.querySelector('meta[name=author]') || {}).content || '',
              });
              await Services.Notes.save({ vars, bodyTpl: Config.data.notes.templates.noteBody, action: 'note' });
              FloatBtn.setState('ok', 1500);
              Toast.show('已保存', 2000, 'success');
            } catch (e) {
              FloatBtn.setState('err', 3000);
              Pure.handleError(e);
            } finally {
              clearBusy('note');
            }
          },
          onCancel: () => clearBusy('note'),
        });
      });
    },
    async clip() {
      await this._run('clip', async () => {
        await ensureClipLibs();   // 首次剪藏先拉取 Readability/Turndown;失败则走降级
        const article = cachedArticle();
        let vars;
        if (article) {
          const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
          try { td.use(turndownPluginGfm.gfm); } catch (e) { /* ignore */ }
          vars = Pure.getTemplateVars({
            title: article.title || document.title || 'untitled',
            author: (article.byline || (document.querySelector('meta[name=author]') || {}).content || ''),
            excerpt: (article.excerpt || '').slice(0, 200),
            content: td.turndown(article.content),
          });
        } else {
          // CDN/Readability 不可用时的降级：纯文本正文
          vars = Pure.getTemplateVars({
            content: (document.body.innerText || '').slice(0, 20000),
          });
        }
        if ((vars.content || '').replace(/\s|<[^>]+>/g, '').length < 50) {
          throw new Error('此页面无法提取正文（非文章页？）');
        }
        await Services.Notes.save({ vars, bodyTpl: Config.data.notes.templates.clipBody, action: 'clip' });
      }, '已剪藏');
    },
    async translatePage() {
      if (PageTrans.active) { PageTrans.stop(); FloatBtn.setState('ok', 1200); Toast.show('已停止翻译'); return; }
      await this._run('translate', () => PageTrans.start(), '翻译完成');
    },
    async openChat() {
      // If invoked from selection mode, seed the dialog with the selection
      // as initial context (selection → chat requirement).
      const sel = (State.mode === 'selection' && State.selectionText) || '';
      const anchor = SubBalls.anchorOf('chat');
      AIDialog.open(sel ? { initialContext: sel, anchor, trigger: 'chat' } : { anchor, trigger: 'chat' });
    },
    // --- Selection ---
    async annotate() {
      const sel = State.selectionText || '';
      await this._run('annotate', () => {
        InputPanel.open({
          title: '批注',
          placeholder: '可空 — 直接保存即可作为选区片段',
          trigger: 'annotate',
          quote: sel,
          anchor: SubBalls.anchorOf('annotate') || { x: FloatBtn.x(), y: FloatBtn.y() },
          onSave: async (comment) => {
            try {
              const vars = Pure.getTemplateVars({
                selection: sel,
                excerpt: sel.slice(0, 160),
                comment: comment || '',
              });
              // choose template: full annotate if comment present, otherwise snippet
              const bodyTpl = (comment && comment.trim())
                ? Config.data.notes.templates.annotateBody
                : Config.data.notes.templates.annotateSnippet;
              await Services.Notes.save({ vars, bodyTpl, action: (comment && comment.trim()) ? 'annotate' : 'snippet' });
              FloatBtn.setState('ok', 1500);
              Toast.show('已批注', 2000, 'success');
            } catch (e) {
              FloatBtn.setState('err', 3000);
              Pure.handleError(e);
            } finally {
              clearBusy('annotate');
            }
          },
          onCancel: () => clearBusy('annotate'),
        });
      });
    },
    async wordAction() {
      // 划词面板已融合进对话面板：以 action 模式打开对话面板，
      // 提示词胶囊位于顶部（原划词面板 tabs 位置），按默认动作自动执行
      const sel = State.selectionText || '';
      const act = (Config.data.selection && Config.data.selection.defaultAction) || 'none';
      AIDialog.open({
        mode: 'action',
        sel,
        trigger: 'word',
        anchor: SubBalls.anchorOf('word') || { x: FloatBtn.x(), y: FloatBtn.y() },
        autoRun: act,
      });
    },
    async searchSelection() {
      const sel = State.selectionText || '';
      const engines = (Config.data.search && Config.data.search.engines) || [];
      SearchPop.show(SubBalls.anchorOf('search') || { x: FloatBtn.x(), y: FloatBtn.y() }, engines, sel);
    },
  };
  // 子球 id → Action 方法 别名(修复:子球 id 与 Action 方法名不一致,导致部分子球点击无响应)
  // translate→translatePage / chat→openChat / word→wordAction / search→searchSelection
  Actions.translate = Actions.translatePage;
  Actions.chat = Actions.openChat;
  Actions.word = Actions.wordAction;
  Actions.search = Actions.searchSelection;

  // ============================================================
  // §24  PANEL  (settings, Shadow DOM)
  // ============================================================
  const Panel = {
    host: null,
    close() {
      if (!this.host) return;
      // 恢复背景滚动锁定（open 里改过 overflow）
      try { document.body.style.overflow = this._prevOverflow || ''; } catch (e) { /* ignore */ }
      this.host.remove();
      this.host = null;
      this._prevOverflow = null;
    },
    open() {
      if (this.host) return;
      const { host, root } = Pure.createHost(STYLE_PANEL);
      this.host = host;
      const wrap = document.createElement('div');
      wrap.className = 'wrap';
      wrap.innerHTML = renderPanelHTML();
      root.appendChild(wrap);
      (document.body || document.documentElement).appendChild(this.host);
      // lock background scroll while the modal is open
      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      this._prevOverflow = prevOverflow;
      const _snapshot = JSON.parse(JSON.stringify(Config.data));
      bindPanel(this.host, () => this.close(), _snapshot);
    },
  };

  function renderPanelHTML() {
    const c = Config.data;
    const varTags = ['title', 'url', 'hostname', 'author', 'excerpt', 'content', 'selection', 'comment', 'date', 'year', 'month', 'day', 'hour', 'minute'].map((v) =>
      '<span class="tag" data-act="insert-var" data-var="' + v + '">{{' + v + '}}</span>'
    ).join(' ');
    return '' +
      '<div class="card">' +
        '<div class="hdr"><span>orb 设置</span><span class="x" data-act="close" role="button" aria-label="关闭">×</span></div>' +
        '<div class="body">' +
          // Ball (主按钮)
          '<div class="section"><h4>主按钮</h4>' +
            '<div class="row"><label>双击动作</label><select data-act="ball.doubleClickAction">' +
              '<option value="note">快速记录</option>' +
              '<option value="clip">剪藏</option>' +
              '<option value="translate">翻译</option>' +
              '<option value="chat">对话</option>' +
              '<option value="flip">翻页</option>' +
            '</select></div>' +
            '<div class="row"><label>纵向位置</label><span style="flex:1;display:flex;align-items:center;gap:8px;"><input type=range min=5 max=95 step=1 data-act="ball.topPct" style="flex:1;"><span data-display="ball.topPct" style="font-size:12px;color:#888;min-width:36px;text-align:right;">45%</span></span></div>' +
            '<div class="row"><label>边缘距离</label><span style="flex:1;display:flex;align-items:center;gap:8px;"><input type=range min=4 max=60 step=1 data-act="ball.edge" style="flex:1;"><span data-display="ball.edge" style="font-size:12px;color:#888;min-width:36px;text-align:right;">16px</span></span></div>' +
            '<div class="row"><label class="lbl-top">全局子球</label><span class="ball-group">' +
              '<label class="chk-lbl"><input type=checkbox data-ball="global" value="flip">翻页</label>' +
              '<label class="chk-lbl"><input type=checkbox data-ball="global" value="note">记录</label>' +
              '<label class="chk-lbl"><input type=checkbox data-ball="global" value="clip">剪藏</label>' +
              '<label class="chk-lbl"><input type=checkbox data-ball="global" value="translate">翻译</label>' +
              '<label class="chk-lbl"><input type=checkbox data-ball="global" value="chat">对话</label>' +
            '</span></div>' +
            '<div class="row"><label class="lbl-top">划词子球</label><span class="ball-group">' +
              '<label class="chk-lbl"><input type=checkbox data-ball="selection" value="annotate">批注</label>' +
              '<label class="chk-lbl"><input type=checkbox data-ball="selection" value="word">划词</label>' +
              '<label class="chk-lbl"><input type=checkbox data-ball="selection" value="chat">对话</label>' +
              '<label class="chk-lbl"><input type=checkbox data-ball="selection" value="search">搜索</label>' +
            '</span></div>' +
            '<div class="row"><label class="lbl-top">快捷键</label><span style="flex:1;font-size:12px;color:#888;line-height:1.8;">Alt+T 翻译 · Alt+C 对话 · Alt+N 记录 · Alt+S 设置 · Esc 关闭面板</span></div>' +
          '</div>' +
          // Notes
          '<div class="section"><h4>笔记保存</h4>' +
            '<div class="row"><label>服务</label><select data-act="notes.provider">' +
              '<option value="obsidian">Obsidian (URI + 剪贴板)</option>' +
              '<option value="github">GitHub</option>' +
              '<option value="gitee">Gitee</option>' +
              '<option value="webdav">WebDAV</option>' +
            '</select></div>' +
            '<div data-section="obsidian"><div class="row"><label>Vault</label><input type=text data-act="notes.obsidian.vault"></div></div>' +
            '<div data-section="github"><div class="row"><label>Token</label><input type=password data-act="notes.github.token"></div><div class="row"><label>Owner</label><input type=text data-act="notes.github.owner"></div><div class="row"><label>Repo</label><input type=text data-act="notes.github.repo"></div><div class="row"><label>Branch</label><input type=text data-act="notes.github.branch"></div></div>' +
            '<div data-section="gitee"><div class="row"><label>Token</label><input type=password data-act="notes.gitee.token"></div><div class="row"><label>Owner</label><input type=text data-act="notes.gitee.owner"></div><div class="row"><label>Repo</label><input type=text data-act="notes.gitee.repo"></div><div class="row"><label>Branch</label><input type=text data-act="notes.gitee.branch"></div></div>' +
            '<div data-section="webdav"><div class="row"><label>地址</label><input type=text data-act="notes.webdav.url" placeholder="https://dav.example.com"></div><div class="row"><label>用户名</label><input type=text data-act="notes.webdav.username"></div><div class="row"><label>密码</label><input type=password data-act="notes.webdav.password"></div></div>' +
            '<div class="row"><label class="lbl-top">保存路径</label><span style="flex:1;display:flex;flex-direction:column;gap:6px;">' +
            `<span class="path-hint"><b style="width:54px;font-weight:500;color:var(--tx);">记录</b><input type=text data-act="notes.templates.paths.note.path" placeholder="notes/{{title}}.md" class="inp-flex"></span>` +
            `<span class="path-hint"><b style="width:90px;font-weight:500;color:var(--tx);">剪藏/批注/摘抄</b><input type=text data-act="notes.templates.paths.clip.path" placeholder="clips/{{title}}.md" class="inp-flex"></span>` +
          '</span></div>' +
            '<div class="row"><label>变量</label>' + varTags + '</div>' +
            '<div class="row"><label class="lbl-top">前言模板</label><textarea data-act="notes.templates.frontmatter"></textarea></div>' +
            '<div class="row"><label class="lbl-top">剪藏正文</label><textarea data-act="notes.templates.clipBody"></textarea></div>' +
            '<div class="row"><label class="lbl-top">批注正文</label><textarea data-act="notes.templates.annotateBody"></textarea></div>' +
            '<div class="row"><label class="lbl-top">批注片段</label><textarea data-act="notes.templates.annotateSnippet"></textarea></div>' +
            '<div class="row"><label class="lbl-top">记录</label><textarea data-act="notes.templates.noteBody"></textarea></div>' +
          '</div>' +
          // Translate
          '<div class="section"><h4>翻译</h4>' +
            '<div class="row"><label>服务</label><select data-act="translate.provider">' +
              '<option value="edge">微软 Edge (默认,免配置)</option>' +
              '<option value="tencent">腾讯交互翻译</option>' +
              '<option value="ali">阿里翻译</option>' +
              '<option value="ai">AI 翻译 (OpenAI/Anthropic)</option>' +
            '</select></div>' +
            '<div class="row"><label>目标语言</label><select data-act="translate.target">' +
              '<option value="zh">简体中文</option>' +
              '<option value="zh-TW">繁体中文</option>' +
              '<option value="en">English</option>' +
              '<option value="ja">日本語</option>' +
              '<option value="ko">한국어</option>' +
              '<option value="fr">Français</option>' +
              '<option value="de">Deutsch</option>' +
              '<option value="es">Español</option>' +
              '<option value="ru">Русский</option>' +
              '<option value="pt">Português</option>' +
              '<option value="it">Italiano</option>' +
              '<option value="nl">Nederlands</option>' +
              '<option value="ar">العربية</option>' +
              '<option value="hi">हिन्दी</option>' +
              '<option value="th">ไทย</option>' +
              '<option value="vi">Tiếng Việt</option>' +
              '<option value="id">Bahasa Indonesia</option>' +
              '<option value="tr">Türkçe</option>' +
            '</select></div>' +
            '<div class="row"><label>自动翻译</label><input type=checkbox data-act="translate.autoPage"><span class="hint">页面加载后自动翻译外文内容</span></div>' +
            '<div class="row"><label>AI 服务</label><select data-act="translate.aiService" id="sel-translate-ai"></select><span class="hint">选择 AI 翻译使用的服务与模型</span></div>' +
            '<div class="row"><label class="lbl-top">AI 提示词</label><textarea data-act="translate.aiPrompt"></textarea></div>' +
            '<div class="hint">AI 翻译时 {{langName}} 替换为目标语言</div>' +
          '</div>' +
          // AI 服务池（独立模块：只负责增减、编辑 AI 服务）
          '<div class="section"><h4>AI 服务</h4>' +
            '<div id="ai-svc-list"></div>' +
            '<div class="row"><span class="btn" data-act="ai.add">＋ 添加服务</span></div>' +
            '<div class="hint">翻译、对话、划词在此配置服务</div>' +
          '</div>' +
          // AI 对话（独立模块）
          '<div class="section"><h4>AI 对话</h4>' +
            '<div class="row"><label>使用服务</label><select data-act="ai.chatService" id="sel-chat-ai"></select></div>' +
            '<div class="hint">选择对话使用的服务与模型</div>' +
            '<div class="row"><label>包含网页内容</label><input type=checkbox data-act="ai.includePageContent"></div>' +
            '<div class="row"><label>提示词预设</label><span class="btn" data-act="ai.presetAdd">＋ 添加预设</span></div>' +
            '<div class="hint">点击变量插入到输入框：<span class="tag" data-act="insert-var" data-var="content">{{content}}</span> <span class="tag" data-act="insert-var" data-var="selection">{{selection}}</span> <span class="tag" data-act="insert-var" data-var="context">{{context}}</span> <span class="tag" data-act="insert-var" data-var="title">{{title}}</span> <span class="tag" data-act="insert-var" data-var="url">{{url}}</span> <span class="tag" data-act="insert-var" data-var="date">{{date}}</span> <span class="tag" data-act="insert-var" data-var="time">{{time}}</span></div>' +
            '<div id="preset-list"></div>' +
          '</div>' +
          // Selection
          '<div class="section"><h4>划词</h4>' +
            '<div class="row"><label>AI 服务</label><select data-act="selection.aiService" id="sel-selection-ai"></select><span class="hint">选择划词处理使用的服务与模型</span></div>' +
            '<div class="row"><label>默认动作</label><select data-act="selection.defaultAction" id="sel-selection-default"></select><span class="hint">划词后自动执行的提示词</span></div>' +
            '<div class="row"><label>最小选中文本</label><input type=text data-act="selection.threshold"></div>' +
            '<div class="row"><label>触发延迟</label><input type=text data-act="selection.debounceMs"></div>' +
          '</div>' +
          // Search
          '<div class="section"><h4>搜索</h4>' +
            '<div class="row"><label>搜索引擎</label><span class="btn" data-act="search.add">＋ 添加引擎</span></div>' +
            '<div id="search-eng-list"></div>' +
            '<div class="hint">搜索词用 %s 占位</div>' +
          '</div>' +
        '</div>' +
        '<div class="ftr"><span class="btn danger" data-act="reset">重置默认</span><span class="btn" data-act="cancel">取消</span><span class="btn primary" data-act="save">保存</span></div>' +
      '</div>';
  }

  function bindPanel(host, onClose, snapshot) {
    const root = host.shadowRoot;
    const c = Config.data;
    let _saved = false;
    let lastFocusedTextarea = null;
    root.addEventListener('focusin', (e) => {
      if (e.target.tagName === 'TEXTAREA') lastFocusedTextarea = e.target;
    });
    // populate
    // populate：遍历 [data-act] 自动填充（与 save 侧同一约定；AI 服务下拉由 renderAiServices 处理）
    root.querySelectorAll('[data-act]').forEach((el) => {
      const a = el.dataset.act;
      if (!Config.hasPath(a)) return;
      if (a === 'translate.aiService' || a === 'ai.chatService' || a === 'selection.aiService') return;
      let o = c;
      for (const k of a.split('.')) o = (o == null) ? undefined : o[k];
      if (o === undefined) return;
      if (el.type === 'checkbox') el.checked = !!o;
      else if (a === 'ball.topPct') el.value = String(Math.round((o || 0.45) * 100));
      else el.value = (o == null) ? '' : o;
    });
    renderAiServices(root);
    renderSearchEngines(root);
    renderPresets(root);
    renderSelectionDefault(root, c.selection.defaultAction);
    let ballKinds = ['global', 'selection'];
    for (let bi = 0; bi < ballKinds.length; bi++) {
      let bk = ballKinds[bi];
      let benabled = (c.balls && c.balls[bk]) || [];
      let bcheckboxes = root.querySelectorAll('input[data-ball="' + bk + '"]');
      for (let ci = 0; ci < bcheckboxes.length; ci++) {
        bcheckboxes[ci].checked = benabled.indexOf(bcheckboxes[ci].value) >= 0;
      }
    }
    // 滑块旁边显示百分比
    const topPctDisp = root.querySelector('[data-display="ball.topPct"]');
    if (topPctDisp) topPctDisp.textContent = Math.round(((c.ball && c.ball.topPct) || 0.45) * 100) + '%';
    const edgeDisp = root.querySelector('[data-display="ball.edge"]');
    if (edgeDisp) edgeDisp.textContent = ((c.ball && c.ball.edge) || 16) + 'px';
    // 实时 preview:滑块拖动时直接更新球位置,松手后由 save handler 持久化
    const topPctRange = root.querySelector('[data-act="ball.topPct"]');
    if (topPctRange) {
      const edgeRange = root.querySelector('[data-act="ball.edge"]');
      if (edgeRange) {
        edgeRange.addEventListener('input', (ev) => {
          const v = parseInt(ev.target.value, 10) || 16;
          const disp = root.querySelector('[data-display="ball.edge"]');
          if (disp) disp.textContent = v + 'px';
          // 实时更新悬浮球位置
          Config.data.ball.edge = v;
          FloatBtn._applyPos();
        });
      }
      topPctRange.addEventListener('input', (ev) => {
        const pct = Math.max(0.05, Math.min(0.95, parseInt(ev.target.value, 10) / 100));
        FloatBtn._topPct = pct;
        FloatBtn._applyPos();
        if (topPctDisp) topPctDisp.textContent = Math.round(pct * 100) + '%';
      });
    }
    function renderAiServices(r) {
      const list = r.querySelector('#ai-svc-list');
      if (!list) return;
      const ai = Config.data.ai || {};
      const svcs = (Array.isArray(ai.services) && ai.services.length) ? ai.services : [];
      list.innerHTML = svcs.map((s, i) =>
        '<div class="ai-svc list-item">' +
          '<div class="row"><label>名称</label><input type=text data-ai="name" value="' + Pure.escHtml(s.name) + '"></div>' +
          '<div class="row"><label>类型</label><select data-ai="kind">' +
            '<option value="openai"' + (s.kind === 'anthropic' ? '' : ' selected') + '>OpenAI 兼容</option>' +
            '<option value="anthropic"' + (s.kind === 'anthropic' ? ' selected' : '') + '>Claude (Anthropic)</option>' +
          '</select></div>' +
          '<div class="row"><label>接口地址</label><input type=text data-ai="baseURL" value="' + Pure.escHtml(s.baseURL) + '"></div>' +
          '<div class="row"><label>密钥</label><input type="password" data-ai="apiKey" value="' + Pure.escHtml(s.apiKey) + '"></div>' +
          '<div class="row"><label>模型</label><input type=text data-ai="model" value="' + Pure.escHtml(s.model) + '" placeholder="一个服务对应一个模型"></div>' +
          '<div class="row"><label>联网搜索</label><label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" data-ai="enableSearch"' + (s.enableSearch ? ' checked' : '') + '> 启用</label></div>' +
          '<div class="row"><label></label><span class="btn danger" data-ai="remove">删除</span></div>' +
        '</div>'
      ).join('');
      // 各模块「AI 服务」下拉：每服务单模型，选中服务即确定模型
      const mods = [
        ['#sel-translate-ai', (Config.data.translate || {}).aiService],
        ['#sel-chat-ai', (Config.data.ai || {}).chatService],
        ['#sel-selection-ai', (Config.data.selection || {}).aiService],
      ];
      mods.forEach(([sel, curSvcName]) => {
        const el = r.querySelector(sel);
        if (!el) return;
        el.innerHTML = svcs.map((s) =>
          '<option value="' + Pure.escHtml(s.name) + '">' + Pure.escHtml(s.name + ' / ' + (s.model || '')) + '</option>'
        ).join('');
        const curSvc = svcs.find((s) => s.name === curSvcName) || svcs[0];
        el.value = (curSvc && curSvc.name) || '';
      });
    }
    function renderSearchEngines(r) {
      const list = r.querySelector('#search-eng-list');
      if (!list) return;
      const engs = (Config.data.search && Config.data.search.engines) || [];
      list.innerHTML = engs.map((e) =>
        '<div class="eng-row list-item">' +
          '<div class="li-top"><input type=text data-se="name" value="' + Pure.escHtml(e.name) + '" placeholder="名称">' +
          '<span class="btn danger" data-se="remove">删除</span></div>' +
          '<input type=text class="li-main" data-se="url" value="' + Pure.escHtml(e.url) + '" placeholder="https://…?q=%s">' +
        '</div>'
      ).join('');
    }
        function renderPresets(r) {
      const list = r.querySelector('#preset-list');
      if (!list) return;
      const presets = (Config.data.ai && Array.isArray(Config.data.ai.presets)) ? Config.data.ai.presets : [];
      list.innerHTML = presets.map((p) =>
        '<div class="pre-row list-item">' +
          '<div class="li-top"><input type=text data-pre="name" value="' + Pure.escHtml(p.name) + '" placeholder="名称">' +
          '<span class="btn danger" data-pre="remove">删除</span></div>' +
          '<textarea class="li-main" data-pre="prompt" placeholder="提示词">' + Pure.escHtml(p.prompt) + '</textarea>' +
        '</div>'
      ).join('');
      // 同步更新默认动作下拉
      const curSel = r.querySelector('#sel-selection-default');
      if (curSel) {
        const curVal = curSel.value;
        renderSelectionDefault(r, curVal || Config.data.selection.defaultAction);
      }
    }
    function renderSelectionDefault(r, cur) {
      const sel = r.querySelector('#sel-selection-default');
      if (!sel) return;
      const presets = (Config.data.ai && Array.isArray(Config.data.ai.presets)) ? Config.data.ai.presets : [];
      const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      sel.innerHTML =
        '<option value="none">不自动执行</option>' +
        presets.map((p) => '<option value="' + Pure.escHtml(p.name) + '">' + Pure.escHtml(p.name) + '</option>').join('');
      sel.value = String(cur == null ? '' : cur);
    }

    function showSections() {
      const np = c.notes.provider;
      root.querySelector('[data-section=obsidian]').style.display = (np === 'obsidian') ? '' : 'none';
      root.querySelector('[data-section=github]').style.display = (np === 'github') ? '' : 'none';
      root.querySelector('[data-section=gitee]').style.display = (np === 'gitee') ? '' : 'none';
      root.querySelector('[data-section=webdav]').style.display = (np === 'webdav') ? '' : 'none';
    }
    showSections();
    // events
    root.addEventListener('change', (ev) => {
      const t = ev.target;
      if (!t.dataset) return;
      const act = t.dataset.act;
      if (!act) return;
      if (act === 'notes.provider') {
        c.notes.provider = getVal('notes.provider') || c.notes.provider;
        showSections();
      }
    });
    root.addEventListener('click', (ev) => {
      // 用 closest 命中按钮（设置面板按钮内嵌 SVG 图标时 target 是 path/svg）
      const t = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!t || !t.dataset) return;
      const act = t.dataset.act;
      if (t.dataset.ai === 'remove') {
        const card = t.closest('.ai-svc');
        const all = root.querySelectorAll('.ai-svc');
        const idx = card ? Array.prototype.indexOf.call(all, card) : -1;
        if (Array.isArray(Config.data.ai.services) && Config.data.ai.services.length <= 1) {
          Toast.show('至少保留一个 AI 服务');
          return;
        }
        if (idx >= 0 && Array.isArray(Config.data.ai.services)) {
          const svc = Config.data.ai.services[idx];
          // 删除前检查各模块引用，避免静默回退到 list[0]
          if (svc) {
            const refs = [];
            if (Config.data.translate && Config.data.translate.aiService === svc.name) refs.push('翻译');
            if (Config.data.ai && Config.data.ai.chatService === svc.name) refs.push('AI对话');
            if (refs.length) {
              Toast.show('已删除 ' + svc.name, 2000, 'success');
            }
          }
          Config.data.ai.services.splice(idx, 1);
          renderAiServices(root);
        }
        return;
      }
      if (t.dataset.se === 'remove') {
        const row = t.closest('.eng-row');
        const all = root.querySelectorAll('.eng-row');
        const idx = row ? Array.prototype.indexOf.call(all, row) : -1;
        const engs = Config.data.search && Config.data.search.engines;
        if (Array.isArray(engs) && engs.length <= 1) { Toast.show('至少保留一个搜索引擎'); return; }
        if (idx >= 0 && Array.isArray(engs)) { engs.splice(idx, 1); renderSearchEngines(root); }
        return;
      }
      if (act === 'search.add') {
        if (!Array.isArray(Config.data.search.engines)) Config.data.search.engines = [];
        Config.data.search.engines.push({ name: '新引擎' + (Config.data.search.engines.length + 1), url: 'https://www.google.com/search?q=%s' });
        renderSearchEngines(root);
        return;
      }
      if (t.dataset.pre === 'remove') {
        const prow = t.closest('.pre-row');
        const pall = root.querySelectorAll('.pre-row');
        const pidx = prow ? Array.prototype.indexOf.call(pall, prow) : -1;
        const presets = Config.data.ai && Config.data.ai.presets;
        if (Array.isArray(presets) && pidx >= 0) { presets.splice(pidx, 1); renderPresets(root); }
        return;
      }
      if (act === 'ai.presetAdd') {
        const ai = Config.data.ai;
        if (!Array.isArray(ai.presets)) ai.presets = [];
        ai.presets.push({ name: '新预设' + (ai.presets.length + 1), prompt: '请处理以下内容。' });
        renderPresets(root);
        return;
      }
      if (act === 'ai.add') {
        const ai = Config.data.ai;
        if (!Array.isArray(ai.services)) ai.services = [];
        ai.services.push({ name: '新服务' + (ai.services.length + 1), kind: 'openai', baseURL: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini', enableSearch: false });
        renderAiServices(root);
        return;
      }
      if (act === 'insert-var') {
        const v = t.dataset.var;
        const focused = lastFocusedTextarea;
        if (focused) {
          const ins = '{{' + v + '}}';
          const s = focused.selectionStart || 0;
          const e = focused.selectionEnd || 0;
          focused.value = focused.value.slice(0, s) + ins + focused.value.slice(e);
          focused.focus();
        }
        return;
      }
      if (act === 'close' || act === 'cancel') {
        if (!_saved && snapshot) { try { Config.data = JSON.parse(JSON.stringify(snapshot)); } catch (e) { /* ignore */ } }
        onClose();
      }
      else if (act === 'reset') {
        if (confirm('重置所有设置为默认值?')) {
          Config.reset();
          onClose();
          setTimeout(() => Panel.open(), 50);
        }
      } else if (act === 'save') {
        // collect all
        const paths = [];
        root.querySelectorAll('[data-act]').forEach((el) => {
          const a = el.dataset.act;
          if (Config.hasPath(a)) {
            paths.push({ el: el, path: a });
          }
        });
        paths.forEach(({ el, path }) => {
          let v;
          if (el.type === 'checkbox') v = el.checked;
          else v = el.value;
          if (path === 'selection.threshold') v = parseInt(v, 10) || 2;
          if (path === 'selection.debounceMs') v = parseInt(v, 10) || 300;
          if (path === 'ball.topPct') v = Math.max(0.05, Math.min(0.95, parseInt(v, 10) / 100));
          if (path === 'ball.edge') v = Math.max(4, Math.min(60, parseInt(v, 10) || 16));
          Config.patch(path, v);
        });
        if (!Config.data.balls) Config.data.balls = {};
        for (let si = 0; si < ballKinds.length; si++) {
          let sk = ballKinds[si];
          let senabled = [];
          let scheckboxes = root.querySelectorAll('input[data-ball="' + sk + '"]:checked');
          for (let sj = 0; sj < scheckboxes.length; sj++) senabled.push(scheckboxes[sj].value);
          Config.data.balls[sk] = senabled;
        }
        // AI 服务池：从卡片 DOM 重建
        const svcs = [];
        root.querySelectorAll('.ai-svc').forEach((card, i) => {
          const g = (f) => { const el = card.querySelector('[data-ai="' + f + '"]'); return el ? el.value : ''; };
          const gc = (f) => { const el = card.querySelector('[data-ai="' + f + '"]'); return el ? !!el.checked : false; };
          svcs.push({
            name: g('name') || ('服务' + (i + 1)),
            kind: g('kind') === 'anthropic' ? 'anthropic' : 'openai',
            baseURL: g('baseURL'),
            apiKey: g('apiKey'),
            model: g('model').trim(),
            enableSearch: gc('enableSearch'),
          });
        });
        if (svcs.length) c.ai.services = svcs;
        // 搜索引擎：从列表 DOM 重建
        const engs = [];
        root.querySelectorAll('.eng-row').forEach((row) => {
          const n = row.querySelector('[data-se="name"]').value.trim();
          const u = row.querySelector('[data-se="url"]').value.trim();
          if (n && u) engs.push({ name: n, url: u });
        });
        c.search.engines = engs;
        // 对话提示词预设：从 DOM 重建
        const presets2 = [];
        root.querySelectorAll('.pre-row').forEach((row) => {
          const pn = row.querySelector('[data-pre="name"]').value.trim();
          const pp = row.querySelector('[data-pre="prompt"]').value;
          if (pn && pp.trim()) presets2.push({ name: pn, prompt: pp });
        });
        if (!c.ai) c.ai = {};
        c.ai.presets = presets2;
        Config.save();
        _saved = true;
        Toast.show('已保存', 2000, 'success');
        onClose();
      }
    });
    function getVal(path) {
      const el = root.querySelector('[data-act="' + path + '"]');
      if (!el) return null;
      return el.value;
    }
  }

  // ============================================================
  // §25  BOOTSTRAP
  // ============================================================
  function init() {
    if (typeof document === 'undefined') return;
    try {
    Config.load();
    injectGlobalStyles();   // .sub, .search-pop, .orb-trans-line live in document.body
    FloatBtn.ensure();
    SubBalls.initSelectionWatch();
    // manual 收起模式:子球点完不收起,外部点击也不收起,只点主球才收起。
    // 这里不再绑 mousedown 来 collapse。
    // Esc 仅关 dialog / card / search-pop(跟"展开"无关),不收起子球栈。
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        AIDialog.close();
        SearchPop.hide();
        InputPanel.hide();
        Panel.close();
        return;
      }
      // 快捷键:输入框中不触发
      let tgt = e.target;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      let k = e.key.toLowerCase();
      if (k === 't') { e.preventDefault(); Actions.translatePage(); }
      else if (k === 'c') { e.preventDefault(); Actions.openChat(); }
      else if (k === 'n') { e.preventDefault(); Actions.note(); }
      else if (k === 's') { e.preventDefault(); Panel.open(); }
    });
    // 自动翻译外文（可选）：页面加载后直接启动整页翻译。
    // PageTrans 内部逐块跳过已是目标语言的内容，只翻译外文部分 —— 无需页面级语言检测
    if (Config.data.translate && Config.data.translate.autoPage) {
      function autoPageTranslate() {
        try {
          if (!PageTrans.active) PageTrans.start().catch(() => {});
        } catch (e) { /* ignore */ }
      }
      setTimeout(autoPageTranslate, 1500);   // 首屏加载后
      setTimeout(autoPageTranslate, 5000);   // SPA 延迟渲染兜底
    }
    // GM menu
    if (typeof GM_registerMenuCommand === 'function') {
      try {
        GM_registerMenuCommand('orb · 设置', () => Panel.open());
        GM_registerMenuCommand('orb · 重置配置', () => { if (confirm('重置?')) Config.reset(); });
      } catch (e) { /* ignore */ }
    }
    } catch (e) { console.error('[orb] init error:', e); }
  }

  // Expose a small public surface for debugging / tests
  if (typeof globalThis !== 'undefined') {
    globalThis.__ORB__ = { Pure, Storage, Config, Services, Icons, State, FloatBtn, SubBalls, AIDialog, Actions, PageTrans, SearchPop, InputPanel, Panel, Toast, ensureClipLibs };
  }

  // Run if in browser
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
      init();
    }
  }
})();
