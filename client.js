/**
 * PDF knowledge base — browser half.
 *
 * Contributes the sidebar entry and the global panel it opens: upload PDFs,
 * browse their extracted text page by page, inspect the stored knowledge
 * chunks, and ask questions that are answered only from the library.
 */
window.__ModuleLoader__.load({
  id: '@local/pdf-kb',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const PANEL_ID = 'pdf-kb'
    const NS = 'pdf-kb'

    const zh = {
      panel: 'PDF 知识库',
      title: 'PDF 知识库',
      subtitle: '上传 PDF，让文档里的知识可以被检索和提问',
      upload: '上传 PDF',
      uploading: '正在解析…',
      documents: '文档',
      emptyTitle: '知识库还是空的',
      emptyBody: '上传一份 PDF，解析后就能在这里查看内容、浏览知识条目，并基于它提问。',
      dropHint: '把 PDF 拖到这里',
      total: '{docs} 份文档 · {pages} 页 · {chunks} 条知识',
      tabContent: '内容',
      tabKnowledge: '知识',
      tabAsk: '提问',
      delete: '删除',
      deleteConfirm: '删除《{title}》？该文档的知识条目会一并移除。',
      pages: '{n} 页',
      chunks: '{n} 条',
      page: '第 {n} 页',
      pageLabel: '页',
      noSelection: '从左侧选择一份文档',
      noSelectionBody: '选中文档后可以阅读它的正文、查看切分出的知识条目。',
      askPlaceholder: '就这些文档提问，例如：安装部署有哪些步骤？',
      ask: '提问',
      asking: '检索中…',
      answer: '回答',
      sources: '依据',
      missingTitle: '知识库缺少相应知识',
      missingBody: '没有在已收录的文档里找到与该问题相关的内容。可以上传相关 PDF，或换一种问法。',
      missingCoverage: '仅匹配到 {n}% 的关键词',
      error: '出错了',
      retry: '重试',
      refresh: '刷新',
      unnamed: '未命名文档',
      chars: '{n} 字',
      errPDF_ENCRYPTED: '这个 PDF 已加密，需要打开口令，暂无法解析。',
      errPDF_NO_TEXT: '没有解析出文字。如果是扫描件（图片型 PDF），目前还不支持。',
      errPDF_INVALID: '文件不是有效的 PDF。',
      errPDF_EMPTY: '文件是空的。',
      errPDF_TOO_LARGE: '文件超过 96 MB，请拆分后再上传。',
      errKB_ERROR: '处理失败',
      askEmpty: '先输入问题',
      alreadyInLibrary: '《{title}》已经在知识库里了，直接为你打开。',
    }

    const en = {
      panel: 'PDF library',
      title: 'PDF library',
      subtitle: 'Upload PDFs and turn their content into knowledge you can browse and ask about',
      upload: 'Upload PDF',
      uploading: 'Parsing…',
      documents: 'Documents',
      emptyTitle: 'The library is empty',
      emptyBody: 'Upload a PDF to read its content here, browse the knowledge chunks extracted from it, and ask questions about it.',
      dropHint: 'Drop a PDF here',
      total: '{docs} documents · {pages} pages · {chunks} chunks',
      tabContent: 'Content',
      tabKnowledge: 'Knowledge',
      tabAsk: 'Ask',
      delete: 'Delete',
      deleteConfirm: 'Delete "{title}"? Its knowledge chunks are removed too.',
      pages: '{n} pages',
      chunks: '{n} chunks',
      page: 'Page {n}',
      pageLabel: 'Page',
      noSelection: 'Select a document on the left',
      noSelectionBody: 'Open a document to read its text and the knowledge chunks extracted from it.',
      askPlaceholder: 'Ask about these documents, for example: what are the installation steps?',
      ask: 'Ask',
      asking: 'Searching…',
      answer: 'Answer',
      sources: 'Sources',
      missingTitle: 'The library has no knowledge for this',
      missingBody: 'Nothing relevant was found in the stored documents. Upload a related PDF, or try different wording.',
      missingCoverage: 'Only {n}% of the keywords matched',
      error: 'Something went wrong',
      retry: 'Retry',
      refresh: 'Refresh',
      unnamed: 'Untitled document',
      chars: '{n} characters',
      errPDF_ENCRYPTED: 'This PDF is encrypted and needs a password, so it cannot be parsed yet.',
      errPDF_NO_TEXT: 'No text was extracted. Scanned (image-only) PDFs are not supported yet.',
      errPDF_INVALID: 'That file is not a valid PDF.',
      errPDF_EMPTY: 'That file is empty.',
      errPDF_TOO_LARGE: 'That file is larger than 96 MB; split it first.',
      errKB_ERROR: 'Processing failed',
      askEmpty: 'Type a question first',
      alreadyInLibrary: '"{title}" is already in the library — opened it instead.',
    }

    const CSS = `
      .pdfkb-page { display:flex; flex-direction:column; height:100%; box-sizing:border-box;
        padding: calc(var(--dsh-frame-top-clearance, 0px) + 20px) clamp(18px, 3vw, 34px) 22px;
        color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); }
      .pdfkb-head { flex:none; display:flex; align-items:flex-start; gap:16px; }
      .pdfkb-head-text { min-width:0; flex:1; }
      .pdfkb-title { margin:0; font-size:19px; line-height:26px; font-weight:600; letter-spacing:.01em; }
      .pdfkb-subtitle { margin:4px 0 0; font-size:13px; line-height:19px; color: var(--dsw-alias-label-secondary); }
      .pdfkb-stats { margin:8px 0 0; font-size:12px; color: var(--dsw-alias-label-tertiary); }
      .pdfkb-actions { display:flex; gap:8px; align-items:center; }
      .pdfkb-btn { appearance:none; border:1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary); border-radius:8px; padding:6px 12px; font-size:13px; line-height:18px;
        cursor:pointer; font-family:inherit; white-space:nowrap; }
      .pdfkb-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
      .pdfkb-btn:disabled { opacity:.55; cursor:default; }
      .pdfkb-btn-primary { background: var(--dsw-alias-button-primary-fill); border-color:transparent;
        color: var(--dsw-alias-label-primary-foreground); }
      .pdfkb-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
      .pdfkb-body { flex:1; min-height:0; display:grid; grid-template-columns: 264px minmax(0,1fr); gap:18px; margin-top:18px; }
      .pdfkb-list { min-height:0; display:flex; flex-direction:column; gap:8px; overflow:auto; padding-right:2px; }
      .pdfkb-list-title { font-size:12px; font-weight:600; color: var(--dsw-alias-label-tertiary);
        text-transform:uppercase; letter-spacing:.06em; padding:0 2px 2px; }
      .pdfkb-doc { position:relative; display:flex; flex-direction:column; gap:2px; text-align:left;
        border:1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); border-radius:10px;
        padding:9px 11px; cursor:pointer; color:inherit; font-family:inherit; }
      .pdfkb-doc:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .pdfkb-doc[data-active='true'] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-active); }
      .pdfkb-doc-name { font-size:13px; font-weight:600; line-height:18px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .pdfkb-doc-meta { font-size:11px; color: var(--dsw-alias-label-tertiary); }
      .pdfkb-doc-del { position:absolute; top:6px; right:6px; opacity:0; border:0; background:transparent;
        color: var(--dsw-alias-label-tertiary); cursor:pointer; border-radius:6px; padding:2px 5px; font-size:12px; }
      .pdfkb-doc:hover .pdfkb-doc-del { opacity:1; }
      .pdfkb-doc-del:hover { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }
      .pdfkb-main { min-width:0; min-height:0; display:flex; flex-direction:column;
        border:1px solid var(--dsw-alias-border-l2); border-radius:12px; background: var(--dsw-alias-bg-layer-1); overflow:hidden; }
      .pdfkb-tabs { flex:none; display:flex; gap:2px; padding:8px 10px 0; border-bottom:1px solid var(--dsw-alias-border-l2); }
      .pdfkb-tab { appearance:none; border:0; background:transparent; font-family:inherit; font-size:13px;
        color: var(--dsw-alias-label-secondary); padding:6px 10px 8px; cursor:pointer; border-bottom:2px solid transparent; }
      .pdfkb-tab[data-active='true'] { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); }
      .pdfkb-pane { flex:1; min-height:0; overflow:auto; padding:16px 18px 24px; }
      .pdfkb-empty { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
        text-align:center; gap:10px; padding:40px 24px; }
      .pdfkb-empty h2 { margin:0; font-size:15px; font-weight:600; }
      .pdfkb-empty p { margin:0; max-width:420px; font-size:13px; line-height:20px; color: var(--dsw-alias-label-secondary); }
      .pdfkb-page-block { margin:0 0 18px; }
      .pdfkb-page-tag { display:inline-block; font-size:11px; color: var(--dsw-alias-label-tertiary);
        border:1px solid var(--dsw-alias-border-l2); border-radius:999px; padding:1px 8px; margin-bottom:6px; }
      .pdfkb-text { margin:0; font-size:13px; line-height:21px; white-space:pre-wrap; word-break:break-word; }
      .pdfkb-chunk { border:1px solid var(--dsw-alias-border-l2); border-radius:10px; padding:10px 12px; margin-bottom:10px;
        background: var(--dsw-alias-bg-layer-2); }
      .pdfkb-chunk-head { display:flex; gap:8px; align-items:center; margin-bottom:6px;
        font-size:11px; color: var(--dsw-alias-label-tertiary); }
      .pdfkb-ask { display:flex; flex-direction:column; gap:12px; }
      .pdfkb-input { width:100%; box-sizing:border-box; resize:vertical; min-height:76px; border-radius:10px;
        border:1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary); font-family:inherit; font-size:13px; line-height:20px; padding:10px 12px; }
      .pdfkb-input:focus { outline:none; border-color: var(--dsw-alias-brand-primary); }
      .pdfkb-answer { border:1px solid var(--dsw-alias-border-l2); border-radius:10px; padding:12px 14px;
        background: var(--dsw-alias-bg-layer-2); font-size:13px; line-height:21px; white-space:pre-wrap; }
      .pdfkb-missing { border:1px solid var(--dsw-alias-state-warn-primary); border-radius:10px; padding:12px 14px;
        background: var(--dsw-alias-state-warn-tertiary); }
      .pdfkb-missing h3 { margin:0 0 4px; font-size:13px; font-weight:600; color: var(--dsw-alias-state-warn-label); }
      .pdfkb-missing p { margin:0; font-size:12px; line-height:19px; color: var(--dsw-alias-label-secondary); }
      .pdfkb-section-label { font-size:12px; font-weight:600; color: var(--dsw-alias-label-tertiary);
        text-transform:uppercase; letter-spacing:.06em; }
      .pdfkb-source { border-left:2px solid var(--dsw-alias-border-l3); padding:2px 0 2px 10px; margin-bottom:12px; }
      .pdfkb-source-head { font-size:12px; color: var(--dsw-alias-label-secondary); margin-bottom:3px; }
      .pdfkb-source-text { font-size:12px; line-height:19px; color: var(--dsw-alias-label-tertiary); }
      .pdfkb-error { color: var(--dsw-alias-state-error-primary); font-size:13px; line-height:20px; }
      .pdfkb-notice { color: var(--dsw-alias-label-secondary); font-size:13px; line-height:20px; }
      .pdfkb-drop { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
        background: color-mix(in srgb, var(--dsw-alias-bg-base) 82%, transparent);
        border:2px dashed var(--dsw-alias-brand-primary); border-radius:12px; font-size:14px;
        color: var(--dsw-alias-label-primary); pointer-events:none; }
      .pdfkb-scroll-hint { font-size:11px; color: var(--dsw-alias-label-caption); }
      @media (max-width: 860px) {
        .pdfkb-body { grid-template-columns: 1fr; grid-template-rows: minmax(120px, 34%) minmax(0,1fr); }
      }
    `

    const format = (template, values) =>
      template.replace(/\{(\w+)\}/g, (_, key) => (values[key] === undefined ? '' : String(values[key])))

    /** Call one Host route; always resolves to the parsed body. */
    const call = async (suffix, init) => {
      try {
        const response = await fetch(new URL(`api/pdfkb${suffix}`, document.baseURI).href, {
          credentials: 'include',
          ...init,
        })
        const body = await response.json().catch(() => ({}))
        if (body && typeof body === 'object') return body
        return { ok: false, code: 'KB_ERROR', message: `HTTP ${response.status}` }
      } catch (error) {
        return { ok: false, code: 'KB_ERROR', message: error?.message ?? 'network error' }
      }
    }

    function PanelIcon({ size }) {
      const dimension = typeof size === 'number' ? size : 18
      return h(
        'svg',
        { width: dimension, height: dimension, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M4.5 3.5h6.2l4.3 4.3v8.7a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1Z',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M10.5 3.7v4.3h4.3', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
        h('path', { d: 'M6.9 11.4h6.2M6.9 14h4.4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
      )
    }

    /** One document row in the left list. */
    function DocumentRow({ doc, active, t, onSelect, onDelete }) {
      return h(
        'div',
        {
          className: 'pdfkb-doc',
          'data-active': active ? 'true' : 'false',
          role: 'button',
          tabIndex: 0,
          onClick: () => onSelect(doc.id),
          onKeyDown: event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onSelect(doc.id)
            }
          },
        },
        h('span', { className: 'pdfkb-doc-name', title: doc.title }, doc.title || t('unnamed')),
        h(
          'span',
          { className: 'pdfkb-doc-meta' },
          `${format(t('pages'), { n: doc.pageCount })} · ${format(t('chunks'), { n: doc.chunkCount })}`,
        ),
        h(
          'button',
          {
            className: 'pdfkb-doc-del',
            type: 'button',
            title: t('delete'),
            onClick: event => {
              event.stopPropagation()
              onDelete(doc)
            },
          },
          '✕',
        ),
      )
    }

    function ContentPane({ detail, t }) {
      if (!detail) return null
      const pages = detail.pages.filter(page => page.text.trim().length > 0)
      if (!pages.length) return h('p', { className: 'pdfkb-text' }, t('errPDF_NO_TEXT'))
      return h(
        'div',
        null,
        pages.map(page =>
          h(
            'section',
            { className: 'pdfkb-page-block', key: page.page },
            h('span', { className: 'pdfkb-page-tag' }, format(t('page'), { n: page.page })),
            h('p', { className: 'pdfkb-text' }, page.text),
          ),
        ),
      )
    }

    function KnowledgePane({ detail, t }) {
      if (!detail) return null
      return h(
        'div',
        null,
        detail.chunks.map(chunk =>
          h(
            'article',
            { className: 'pdfkb-chunk', key: chunk.id },
            h(
              'div',
              { className: 'pdfkb-chunk-head' },
              h('span', null, `${format(t('page'), { n: chunk.page })} · #${chunk.id}`),
              h('span', null, format(t('chars'), { n: chunk.text.length })),
            ),
            h('p', { className: 'pdfkb-text' }, chunk.text),
          ),
        ),
      )
    }

    function AskPane({ t, onAsk, asking, result, error, question, setQuestion }) {
      return h(
        'div',
        { className: 'pdfkb-ask' },
        h('textarea', {
          className: 'pdfkb-input',
          value: question,
          placeholder: t('askPlaceholder'),
          onChange: event => setQuestion(event.target.value),
          onKeyDown: event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) onAsk()
          },
        }),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h(
            'button',
            { className: 'pdfkb-btn pdfkb-btn-primary', type: 'button', disabled: asking, onClick: onAsk },
            asking ? t('asking') : t('ask'),
          ),
          h('span', { className: 'pdfkb-scroll-hint' }, 'Ctrl / ⌘ + Enter'),
        ),
        error ? h('p', { className: 'pdfkb-error' }, error) : null,
        result && result.missing
          ? h(
              'div',
              { className: 'pdfkb-missing' },
              h('h3', null, t('missingTitle')),
              h('p', null, t('missingBody')),
              result.coverage
                ? h('p', { style: { marginTop: '6px' } }, format(t('missingCoverage'), { n: Math.round(result.coverage * 100) }))
                : null,
            )
          : null,
        result && !result.missing
          ? h(
              'div',
              null,
              h('div', { className: 'pdfkb-section-label', style: { marginBottom: '6px' } }, t('answer')),
              h('div', { className: 'pdfkb-answer' }, result.answer),
            )
          : null,
        result && result.sources && result.sources.length
          ? h(
              'div',
              { style: { marginTop: '4px' } },
              h(
                'div',
                { className: 'pdfkb-section-label', style: { marginBottom: '8px' } },
                `${t('sources')} · ${result.sources.length}`,
              ),
              result.sources.map((source, index) =>
                h(
                  'div',
                  { className: 'pdfkb-source', key: `${source.documentId}-${source.chunkId ?? index}` },
                  h(
                    'div',
                    { className: 'pdfkb-source-head' },
                    `${source.document} · ${format(t('page'), { n: source.page })}`,
                  ),
                  h('div', { className: 'pdfkb-source-text' }, source.excerpt ?? ''),
                ),
              ),
            )
          : null,
      )
    }

    function PanelPage({ t }) {
      const [documents, setDocuments] = useState([])
      const [totals, setTotals] = useState({ documents: 0, pages: 0, chunks: 0 })
      const [selected, setSelected] = useState(undefined)
      const [detail, setDetail] = useState(undefined)
      const [tab, setTab] = useState('content')
      const [loading, setLoading] = useState(true)
      const [uploading, setUploading] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [question, setQuestion] = useState('')
      const [result, setResult] = useState(undefined)
      const [asking, setAsking] = useState(false)
      const [dragging, setDragging] = useState(false)
      const inputRef = useRef(null)

      const describe = useCallback(
        body => {
          const key = body?.code ? `err${body.code}` : 'errKB_ERROR'
          const translated = t(key)
          if (translated !== key) return translated
          return body?.message ? `${t('error')}: ${body.message}` : t('error')
        },
        [t],
      )

      const loadState = useCallback(async () => {
        const body = await call('/state')
        if (body.ok) {
          setDocuments(body.documents ?? [])
          setTotals(body.totals ?? { documents: 0, pages: 0, chunks: 0 })
          setError('')
        } else {
          setError(describe(body))
        }
        setLoading(false)
      }, [describe])

      const loadDocument = useCallback(
        async id => {
          setSelected(id)
          setDetail(undefined)
          if (!id) return
          const body = await call(`/document?id=${encodeURIComponent(id)}`)
          if (body.ok) setDetail(body.document)
          else setError(describe(body))
        },
        [describe],
      )

      useEffect(() => {
        void loadState()
      }, [loadState])

      useEffect(() => {
        if (!selected && documents.length) void loadDocument(documents[0].id)
      }, [documents, selected, loadDocument])

      const upload = useCallback(
        async file => {
          if (!file) return
          setUploading(true)
          setError('')
          setNotice('')
          const body = await call(`/upload?name=${encodeURIComponent(file.name)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/pdf' },
            body: await file.arrayBuffer(),
          })
          setUploading(false)
          if (!body.ok) {
            setError(describe(body))
            return
          }
          if (body.document?.duplicate) {
            setNotice(format(t('alreadyInLibrary'), { title: body.document.title }))
          }
          await loadState()
          void loadDocument(body.document.id)
          setTab('content')
        },
        [describe, loadState, loadDocument],
      )

      const remove = useCallback(
        async doc => {
          if (!window.confirm(format(t('deleteConfirm'), { title: doc.title }))) return
          const body = await call('/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: doc.id }),
          })
          if (!body.ok) {
            setError(describe(body))
            return
          }
          setSelected(undefined)
          setDetail(undefined)
          setResult(undefined)
          await loadState()
        },
        [describe, loadState, t],
      )

      const ask = useCallback(async () => {
        if (!question.trim()) {
          setError(t('askEmpty'))
          return
        }
        setAsking(true)
        setError('')
        const body = await call('/ask', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question }),
        })
        setAsking(false)
        if (!body.ok) {
          setError(describe(body))
          return
        }
        setResult(body)
      }, [question, t, describe])

      const dropHandlers = {
        onDragOver: event => {
          event.preventDefault()
          setDragging(true)
        },
        onDragLeave: () => setDragging(false),
        onDrop: event => {
          event.preventDefault()
          setDragging(false)
          const file = event.dataTransfer?.files?.[0]
          if (file) void upload(file)
        },
      }

      const stats = format(t('total'), {
        docs: totals.documents,
        pages: totals.pages,
        chunks: totals.chunks,
      })

      return h(
        'div',
        { className: 'pdfkb-page', style: { position: 'relative' }, ...dropHandlers },
        h(
          'header',
          { className: 'pdfkb-head' },
          h(
            'div',
            { className: 'pdfkb-head-text' },
            h('h1', { className: 'pdfkb-title' }, t('title')),
            h('p', { className: 'pdfkb-subtitle' }, t('subtitle')),
            h('p', { className: 'pdfkb-stats' }, stats),
          ),
          h(
            'div',
            { className: 'pdfkb-actions' },
            h(
              'button',
              { className: 'pdfkb-btn', type: 'button', onClick: () => void loadState(), disabled: loading },
              t('refresh'),
            ),
            h(
              'button',
              {
                className: 'pdfkb-btn pdfkb-btn-primary',
                type: 'button',
                disabled: uploading,
                onClick: () => inputRef.current?.click(),
              },
              uploading ? t('uploading') : t('upload'),
            ),
            h('input', {
              ref: inputRef,
              type: 'file',
              accept: 'application/pdf,.pdf',
              style: { display: 'none' },
              onChange: event => {
                const file = event.target.files?.[0]
                event.target.value = ''
                void upload(file)
              },
            }),
          ),
        ),
        error ? h('p', { className: 'pdfkb-error', style: { marginTop: '10px' } }, error) : null,
        !error && notice
          ? h('p', { className: 'pdfkb-notice', style: { marginTop: '10px' } }, notice)
          : null,
        h(
          'div',
          { className: 'pdfkb-body' },
          h(
            'aside',
            { className: 'pdfkb-list' },
            h('span', { className: 'pdfkb-list-title' }, t('documents')),
            documents.map(doc =>
              h(DocumentRow, {
                key: doc.id,
                doc,
                active: doc.id === selected,
                t,
                onSelect: id => void loadDocument(id),
                onDelete: row => void remove(row),
              }),
            ),
          ),
          h(
            'main',
            { className: 'pdfkb-main' },
            documents.length
              ? h(
                  React.Fragment,
                  null,
                  h(
                    'nav',
                    { className: 'pdfkb-tabs' },
                    [
                      ['content', t('tabContent')],
                      ['knowledge', t('tabKnowledge')],
                      ['ask', t('tabAsk')],
                    ].map(([id, label]) =>
                      h(
                        'button',
                        {
                          key: id,
                          className: 'pdfkb-tab',
                          'data-active': tab === id ? 'true' : 'false',
                          type: 'button',
                          onClick: () => setTab(id),
                        },
                        label,
                      ),
                    ),
                  ),
                  h(
                    'section',
                    { className: 'pdfkb-pane' },
                    tab === 'ask'
                      ? h(AskPane, { t, onAsk: () => void ask(), asking, result, error: '', question, setQuestion })
                      : detail
                        ? tab === 'content'
                          ? h(ContentPane, { detail, t })
                          : h(KnowledgePane, { detail, t })
                        : h(
                            'div',
                            { className: 'pdfkb-empty' },
                            h('h2', null, t('noSelection')),
                            h('p', null, t('noSelectionBody')),
                          ),
                  ),
                )
              : h(
                  'div',
                  { className: 'pdfkb-empty' },
                  h('h2', null, loading ? '…' : t('emptyTitle')),
                  h('p', null, t('emptyBody')),
                  h(
                    'button',
                    { className: 'pdfkb-btn pdfkb-btn-primary', type: 'button', onClick: () => inputRef.current?.click() },
                    t('upload'),
                  ),
                ),
          ),
        ),
        dragging ? h('div', { className: 'pdfkb-drop' }, t('dropHint')) : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'pdf-kb: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.pdfkb = 'styles'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'pdf-kb: styles')
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: 6,
                  label: () => t('panel'),
                  locale: NS,
                },
                PanelIcon,
              ),
            ),
          'pdf-kb: sidebar entry',
        )
        ctx.effect(
          () =>
            ctx.slots.inject('main', () =>
              ctx.slots.register(
                {
                  name: 'main',
                  key: PANEL_ID,
                  locale: NS,
                  inject: () => ({ t }),
                },
                PanelPage,
              ),
            ),
          'pdf-kb: panel page',
        )
      },
    }
  },
})
