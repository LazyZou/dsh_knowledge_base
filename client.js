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
      uploadMany: '批量上传 PDF',
      uploading: '正在解析…',
      uploadProgress: '正在发送 {name}（{n}/{m}，{p}%）',
      documents: '文档',
      newGroup: '新建分组',
      groupNamePrompt: '分组名称',
      groupRenamePrompt: '重命名分组',
      groupDeleteConfirm: '删除分组「{name}」？里面的文档会移到「未分组」。',
      groupUngrouped: '未分组',
      groupDelete: '删除分组',
      groupRename: '重命名',
      groupMoveTo: '移动到分组',
      groupCount: '{n} 份',
      groupEmpty: '这个分组还没有文档',
      groupAll: '全部',
      emptyTitle: '知识库还是空的',
      emptyBody: '上传一份 PDF，解析后就能在这里查看内容、浏览知识条目，并基于它提问。',
      dropHint: '把 PDF 拖到这里',
      total: '{docs} 份文档 · {pages} 页 · {topics} 个主题 · {chunks} 条知识',
      tabContent: '内容',
      tabKnowledge: '知识',
      tabAsk: '提问',
      tabTasks: '任务',
      tabTasksBusy: '任务 {n}',
      jobsEmpty: '还没有后台任务。批量上传 PDF 或识别扫描件后，进度会显示在这里。',
      jobProgress: '{done}/{total} 个文件',
      jobPages: '{n}/{m} 页',
      jobFailedCount: '{n} 个失败',
      jobCancel: '取消',
      jobDismiss: '清除',
      jobOpen: '打开',
      jobState_queued: '排队中',
      jobState_running: '进行中',
      jobState_done: '已完成',
      jobState_failed: '失败',
      jobState_cancelled: '已取消',
      jobState_cancelling: '正在取消…',
      jobItem_pending: '等待上传',
      jobItem_uploaded: '已收到',
      jobItem_running: '处理中',
      jobItem_done: '已完成',
      jobItem_failed: '失败',
      jobItem_cancelled: '已取消',
      ocrQueued: '已加入后台识别队列，可以关掉这个页面，进度在「任务」里看。',
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
      knowledgeFilter: '按关键词筛选知识',
      knowledgeSummary: '{topics} 个主题 · {chunks} 条知识',
      topicUntitled: '未分类',
      topicMeta: '{n} 条 · 第 {a}-{b} 页',
      topicMetaOne: '{n} 条 · 第 {p} 页',
      knowledgeEmpty: '这份文档还没有可检索的知识（扫描件识别后才有）。',
      knowledgeNoMatch: '没有匹配的知识条目，换个关键词试试。',
      topicExpand: '展开',
      topicCollapse: '收起',
      scanned: '扫描件',
      ocrPending: '{n} 页待识别',
      ocrRun: '识别扫描页',
      ocrRunning: '识别中…',
      ocrResult: '本次识别 {n} 页，还剩 {m} 页',
      ocrComplete: '全部扫描页已识别',
      ocrStop: '停止',
      ocrStopped: '已停止，还剩 {m} 页',
      ocrBackendLocal: '识别：本机 Tesseract（不消耗 token）',
      ocrBackendVision: '识别：视觉模型（本机未装 Tesseract）',
      ocrBackendNone: '未找到识别后端：安装 Tesseract 或启用视觉工具',
      ocrPageHint: '这一页是扫描图，识别后才有文字',
      ocrEmptyHint: '这一页没有识别出文字',
      errPDF_ENCRYPTED: '这个 PDF 已加密，需要打开口令，暂无法解析。',
      errPDF_NO_TEXT: '扫描件已收录，识别文字后即可检索和提问。',
      errOCR_UNAVAILABLE: '没有可用的识别后端：装 Tesseract，或在开启视觉的会话里运行识别。',
      errOCR_BACKEND_UNAVAILABLE: '视觉后端暂时不可用（超时或限流），稍后重试即可。',
      errOCR_FAILED: '这一页识别失败，可稍后重试。',
      errPDF_INVALID: '文件不是有效的 PDF。',
      errNotPdf: '这些文件不是 PDF，已跳过。',
      errPDF_EMPTY: '文件是空的。',
      errPDF_TOO_LARGE: '文件超过 500 MB，请拆分后再上传。',
      errKB_ERROR: '处理失败',
      askEmpty: '先输入问题',
      alreadyInLibrary: '《{title}》已经在知识库里了，直接为你打开。',
    }

    const en = {
      panel: 'PDF library',
      title: 'PDF library',
      subtitle: 'Upload PDFs and turn their content into knowledge you can browse and ask about',
      upload: 'Upload PDF',
      uploadMany: 'Upload PDFs',
      uploading: 'Parsing…',
      uploadProgress: 'Sending {name} ({n}/{m}, {p}%)',
      documents: 'Documents',
      newGroup: 'New group',
      groupNamePrompt: 'Group name',
      groupRenamePrompt: 'Rename group',
      groupDeleteConfirm: 'Delete the group "{name}"? Its documents move to Ungrouped.',
      groupUngrouped: 'Ungrouped',
      groupDelete: 'Delete group',
      groupRename: 'Rename',
      groupMoveTo: 'Move to group',
      groupCount: '{n}',
      groupEmpty: 'This group has no documents yet',
      groupAll: 'All',
      emptyTitle: 'The library is empty',
      emptyBody: 'Upload a PDF to read its content here, browse the knowledge chunks extracted from it, and ask questions about it.',
      dropHint: 'Drop a PDF here',
      total: '{docs} documents · {pages} pages · {topics} topics · {chunks} chunks',
      tabContent: 'Content',
      tabKnowledge: 'Knowledge',
      tabAsk: 'Ask',
      tabTasks: 'Tasks',
      tabTasksBusy: 'Tasks {n}',
      jobsEmpty: 'No background jobs yet. Batch uploads and scan recognition show their progress here.',
      jobProgress: '{done}/{total} files',
      jobPages: '{n}/{m} pages',
      jobFailedCount: '{n} failed',
      jobCancel: 'Cancel',
      jobDismiss: 'Dismiss',
      jobOpen: 'Open',
      jobState_queued: 'Queued',
      jobState_running: 'Running',
      jobState_done: 'Done',
      jobState_failed: 'Failed',
      jobState_cancelled: 'Cancelled',
      jobState_cancelling: 'Cancelling…',
      jobItem_pending: 'Waiting to upload',
      jobItem_uploaded: 'Received',
      jobItem_running: 'Processing',
      jobItem_done: 'Done',
      jobItem_failed: 'Failed',
      jobItem_cancelled: 'Cancelled',
      ocrQueued: 'Queued for background recognition — you can close this page and watch progress under Tasks.',
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
      knowledgeFilter: 'Filter knowledge by keyword',
      knowledgeSummary: '{topics} topics · {chunks} items',
      topicUntitled: 'Uncategorised',
      topicMeta: '{n} items · pages {a}-{b}',
      topicMetaOne: '{n} items · page {p}',
      knowledgeEmpty: 'This document has no searchable knowledge yet (scanned pages gain text after recognition).',
      knowledgeNoMatch: 'No knowledge item matches that keyword.',
      topicExpand: 'Expand',
      topicCollapse: 'Collapse',
      scanned: 'Scan',
      ocrPending: '{n} pages to recognize',
      ocrRun: 'Recognize scanned pages',
      ocrRunning: 'Recognizing…',
      ocrResult: 'Recognized {n} page(s), {m} left',
      ocrComplete: 'Every scanned page is recognized',
      ocrStop: 'Stop',
      ocrStopped: 'Stopped with {m} page(s) left',
      ocrBackendLocal: 'Recognition: local Tesseract (no tokens)',
      ocrBackendVision: 'Recognition: vision model (Tesseract is not installed)',
      ocrBackendNone: 'No recognition backend: install Tesseract or enable a vision tool',
      ocrPageHint: 'This page is a scan; its text appears after recognition',
      ocrEmptyHint: 'No text was recognized on this page',
      errPDF_ENCRYPTED: 'This PDF is encrypted and needs a password, so it cannot be parsed yet.',
      errPDF_NO_TEXT: 'The scan is stored; recognize its pages to make it searchable.',
      errOCR_UNAVAILABLE: 'No recognition backend is available: install Tesseract, or run recognition in a session with vision enabled.',
      errOCR_BACKEND_UNAVAILABLE: 'The vision backend is unavailable right now (timeout or rate limit); try again later.',
      errOCR_FAILED: 'This page could not be recognized; try again later.',
      errPDF_INVALID: 'That file is not a valid PDF.',
      errNotPdf: 'Those files are not PDFs, so nothing was queued.',
      errPDF_EMPTY: 'That file is empty.',
      errPDF_TOO_LARGE: 'That file is larger than 500 MB; split it first.',
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
      .pdfkb-btn-quiet { background:transparent; border-color:var(--dsw-alias-border-l3);
        color: var(--dsw-alias-label-secondary); }
      .pdfkb-btn-primary { background: var(--dsw-alias-button-primary-fill); border-color:transparent;
        color: var(--dsw-alias-label-primary-foreground); }
      .pdfkb-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
      .pdfkb-body { flex:1; min-height:0; display:grid; grid-template-columns: 264px minmax(0,1fr); gap:18px; margin-top:18px; }
      .pdfkb-list { min-height:0; display:flex; flex-direction:column; gap:8px; overflow:auto; padding-right:2px; }
      .pdfkb-list-title { font-size:12px; font-weight:600; color: var(--dsw-alias-label-tertiary);
        text-transform:uppercase; letter-spacing:.06em; padding:0 2px 2px; }
      .pdfkb-list-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
      .pdfkb-group-new { border:1px solid var(--dsw-alias-border-l2); background:transparent;
        color: var(--dsw-alias-label-secondary); border-radius:8px; padding:3px 8px; font-size:11px;
        cursor:pointer; font-family:inherit; white-space:nowrap; }
      .pdfkb-group-new:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .pdfkb-group { display:flex; flex-direction:column; gap:6px; }
      .pdfkb-group-head { display:flex; align-items:center; gap:2px; }
      .pdfkb-group-toggle { flex:1; min-width:0; display:flex; align-items:center; gap:6px; border:0;
        background:transparent; color: var(--dsw-alias-label-secondary); font-family:inherit; font-size:12px;
        font-weight:600; cursor:pointer; padding:4px; border-radius:6px; text-align:left; }
      .pdfkb-group-toggle:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .pdfkb-group-caret { color: var(--dsw-alias-label-tertiary); font-size:10px; }
      .pdfkb-group-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .pdfkb-group-count { color: var(--dsw-alias-label-tertiary); font-weight:500; }
      .pdfkb-group-act { border:0; background:transparent; color: var(--dsw-alias-label-tertiary); cursor:pointer;
        border-radius:6px; padding:2px 5px; font-size:11px; opacity:0; }
      .pdfkb-group-head:hover .pdfkb-group-act { opacity:1; }
      .pdfkb-group-act:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .pdfkb-group-empty { margin:0 0 4px 18px; font-size:11px; color: var(--dsw-alias-label-tertiary); }
      .pdfkb-doc-group { margin-top:4px; width:100%; font-family:inherit; font-size:11px;
        color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1);
        border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:2px 4px; cursor:pointer; }
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
      .pdfkb-knowledge { display:flex; flex-direction:column; gap:10px; }
      .pdfkb-knowledge-bar { display:flex; gap:10px; align-items:center; }
      .pdfkb-filter { min-height:0; flex:1; padding:7px 10px; font-size:12px; }
      .pdfkb-topic { border:1px solid var(--dsw-alias-border-l2); border-radius:12px; overflow:hidden;
        background: var(--dsw-alias-bg-layer-1); }
      .pdfkb-topic-head { display:flex; gap:8px; align-items:center; width:100%; text-align:left; cursor:pointer;
        padding:9px 12px; background:transparent; border:0; color: var(--dsw-alias-label-primary); font-family:inherit; }
      .pdfkb-topic-head:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .pdfkb-topic-caret { font-size:11px; color: var(--dsw-alias-label-tertiary); width:10px; }
      .pdfkb-topic-title { font-size:13px; font-weight:600; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .pdfkb-topic-meta { font-size:11px; color: var(--dsw-alias-label-tertiary); white-space:nowrap; }
      .pdfkb-topic-body { padding:10px 12px 2px; border-top:1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-base); }
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
      .pdfkb-ocr-bar { display:flex; align-items:center; justify-content:space-between; gap:12px;
        border:1px solid var(--dsw-alias-state-warn-primary); background: var(--dsw-alias-bg-layer-2);
        border-radius:10px; padding:10px 12px; margin-bottom:16px; font-size:12px;
        color: var(--dsw-alias-state-warn-label); }
      .pdfkb-scan-hint { color: var(--dsw-alias-label-tertiary); font-size:12px; margin-bottom:8px; }
      .pdfkb-page-image { display:block; max-width:100%; border:1px solid var(--dsw-alias-border-l2);
        border-radius:8px; background: var(--dsw-alias-bg-layer-2); }
      .pdfkb-drop { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
        background: color-mix(in srgb, var(--dsw-alias-bg-base) 82%, transparent);
        border:2px dashed var(--dsw-alias-brand-primary); border-radius:12px; font-size:14px;
        color: var(--dsw-alias-label-primary); pointer-events:none; }
      .pdfkb-scroll-hint { font-size:11px; color: var(--dsw-alias-label-caption); }
      .pdfkb-tasks { display:flex; flex-direction:column; gap:10px; }
      .pdfkb-task { border:1px solid var(--dsw-alias-border-l2); border-radius:10px;
        background: var(--dsw-alias-bg-layer-1); padding:12px 14px; display:flex; flex-direction:column; gap:8px; }
      .pdfkb-task-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
      .pdfkb-task-title { font-size:13px; font-weight:600; color: var(--dsw-alias-label-primary);
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .pdfkb-task-state { font-size:11px; color: var(--dsw-alias-label-tertiary); flex:none; }
      .pdfkb-task[data-state="done"] .pdfkb-task-state { color: var(--dsw-alias-brand-primary); }
      .pdfkb-task[data-state="failed"] .pdfkb-task-state { color: var(--dsw-alias-state-error-primary); }
      .pdfkb-bar { height:6px; border-radius:999px; background: var(--dsw-alias-bg-layer-3); overflow:hidden; }
      .pdfkb-bar-fill { height:100%; border-radius:999px; background: var(--dsw-alias-brand-primary);
        transition: width .3s ease; }
      .pdfkb-task-meta { display:flex; align-items:center; gap:10px; font-size:12px;
        color: var(--dsw-alias-label-secondary); }
      .pdfkb-task-meta > span:first-child { flex:1; }
      .pdfkb-task-bad { color: var(--dsw-alias-state-error-primary); }
      .pdfkb-task-items { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:4px;
        max-height:180px; overflow:auto; }
      .pdfkb-task-item { display:flex; align-items:center; justify-content:space-between; gap:10px;
        font-size:12px; color: var(--dsw-alias-label-secondary); }
      .pdfkb-task-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .pdfkb-task-item-state { flex:none; color: var(--dsw-alias-label-tertiary); }
      .pdfkb-link { background:none; border:none; padding:0; font:inherit; cursor:pointer;
        color: var(--dsw-alias-brand-primary); }
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

    /**
     * Send one file of an import job. fetch() cannot report upload progress, so
     * the panel uses XHR here: a 500 MB PDF takes long enough that a silent
     * button looks broken.
     */
    const sendFile = (suffix, file, onProgress) =>
      new Promise(resolve => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', new URL(`api/pdfkb${suffix}`, document.baseURI).href)
        xhr.withCredentials = true
        xhr.setRequestHeader('content-type', 'application/pdf')
        xhr.upload.onprogress = event => {
          if (event.lengthComputable && event.total) onProgress(event.loaded / event.total)
        }
        xhr.onload = () => {
          onProgress(1)
          try {
            resolve(JSON.parse(xhr.responseText))
          } catch {
            resolve({ ok: false, code: 'KB_ERROR', message: `HTTP ${xhr.status}` })
          }
        }
        xhr.onerror = () => resolve({ ok: false, code: 'KB_ERROR', message: 'network error' })
        xhr.onabort = () => resolve({ ok: false, code: 'KB_CANCELLED', message: 'upload cancelled' })
        xhr.send(file)
      })

    const FINISHED = new Set(['done', 'failed', 'cancelled'])

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
    function DocumentRow({ doc, active, t, groups, onSelect, onDelete, onGroup }) {
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
          `${format(t('pages'), { n: doc.pageCount })} · ${format(t('chunks'), { n: doc.chunkCount })}`
            + (doc.ocrPending ? ` · ${format(t('ocrPending'), { n: doc.ocrPending })}` : ''),
        ),
        h(
          'select',
          {
            className: 'pdfkb-doc-group',
            value: doc.group || '',
            title: t('groupMoveTo'),
            'aria-label': t('groupMoveTo'),
            onClick: event => event.stopPropagation(),
            onChange: event => {
              event.stopPropagation()
              onGroup(doc, event.target.value)
            },
          },
          [
            h('option', { key: '', value: '' }, t('groupUngrouped')),
            ...groups.map(group => h('option', { key: group.id, value: group.id }, group.name)),
          ],
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

    function ContentPane({ detail, t, onOcr, onStopOcr, ocrBusy }) {
      if (!detail) return null
      const pageImageUrl = page => `api/pdfkb/page-image?id=${encodeURIComponent(detail.id)}&page=${page}`
      const recognized = detail.pages.filter(page => page.text.trim().length > 0)
      const waiting = detail.pages.filter(page => page.text.trim().length === 0 && page.hasImage)
      return h(
        'div',
        null,
        detail.ocrPending
          ? h(
              'div',
              { className: 'pdfkb-ocr-bar' },
              h('span', null, format(t('ocrPending'), { n: detail.ocrPending })),
              h(
                'button',
                { className: 'pdfkb-btn', type: 'button', disabled: ocrBusy, onClick: () => onOcr(detail) },
                ocrBusy ? t('ocrRunning') : t('ocrRun'),
              ),
              ocrBusy
                ? h(
                    'button',
                    { className: 'pdfkb-btn pdfkb-btn-quiet', type: 'button', onClick: () => onStopOcr() },
                    t('ocrStop'),
                  )
                : null,
            )
          : null,
        recognized.map(page =>
          h(
            'section',
            { className: 'pdfkb-page-block', key: page.page },
            h('span', { className: 'pdfkb-page-tag' }, format(t('page'), { n: page.page })),
            h('p', { className: 'pdfkb-text' }, page.text),
          ),
        ),
        waiting.map(page =>
          h(
            'section',
            { className: 'pdfkb-page-block', key: `scan-${page.page}` },
            h('span', { className: 'pdfkb-page-tag' }, format(t('page'), { n: page.page })),
            h('p', { className: 'pdfkb-text pdfkb-scan-hint' }, t(page.ocrStatus === 'done' ? 'ocrEmptyHint' : 'ocrPageHint')),
            h('img', {
              className: 'pdfkb-page-image',
              src: pageImageUrl(page.page),
              alt: format(t('page'), { n: page.page }),
              loading: 'lazy',
            }),
          ),
        ),
        !recognized.length && !waiting.length ? h('p', { className: 'pdfkb-text' }, t('errPDF_NO_TEXT')) : null,
      )
    }

    function KnowledgePane({ detail, t }) {
      const [needle, setNeedle] = useState('')
      const [closed, setClosed] = useState({})
      if (!detail) return null

      const query = needle.trim().toLowerCase()
      const groups = []
      const byName = new Map()
      for (const chunk of detail.chunks ?? []) {
        const name = chunk.topic || ''
        if (query && !`${name}\n${chunk.text}`.toLowerCase().includes(query)) continue
        let group = byName.get(name)
        if (!group) {
          group = { name, chunks: [], chars: 0, firstPage: chunk.page, lastPage: chunk.pageEnd ?? chunk.page }
          byName.set(name, group)
          groups.push(group)
        }
        group.chunks.push(chunk)
        group.chars += chunk.text.length
        group.firstPage = Math.min(group.firstPage, chunk.page)
        group.lastPage = Math.max(group.lastPage, chunk.pageEnd ?? chunk.page)
      }
      groups.sort((left, right) => left.firstPage - right.firstPage)
      const total = groups.reduce((sum, group) => sum + group.chunks.length, 0)

      const toggle = name => {
        setClosed(previous => ({ ...previous, [name]: !previous[name] }))
      }

      return h(
        'div',
        { className: 'pdfkb-knowledge' },
        h(
          'div',
          { className: 'pdfkb-knowledge-bar' },
          h('input', {
            className: 'pdfkb-input pdfkb-filter',
            value: needle,
            placeholder: t('knowledgeFilter'),
            onChange: event => setNeedle(event.target.value),
          }),
          h('span', { className: 'pdfkb-scroll-hint' }, format(t('knowledgeSummary'), { topics: groups.length, chunks: total })),
        ),
        (detail.chunks ?? []).length
          ? null
          : h('p', { className: 'pdfkb-text' }, t('knowledgeEmpty')),
        groups.length || !(detail.chunks ?? []).length
          ? null
          : h('p', { className: 'pdfkb-text' }, t('knowledgeNoMatch')),
        groups.map(group => {
          // Filtering implies the user is looking for matches, so keep groups open.
          const open = Boolean(query) || !closed[group.name]
          const meta = group.firstPage === group.lastPage
            ? format(t('topicMetaOne'), { n: group.chunks.length, p: group.firstPage })
            : format(t('topicMeta'), { n: group.chunks.length, a: group.firstPage, b: group.lastPage })
          return h(
            'section',
            { className: 'pdfkb-topic', key: group.name || '(untitled)' },
            h(
              'button',
              {
                type: 'button',
                className: 'pdfkb-topic-head',
                'aria-expanded': open,
                title: open ? t('topicCollapse') : t('topicExpand'),
                onClick: () => toggle(group.name),
              },
              h('span', { className: 'pdfkb-topic-caret' }, open ? '▾' : '▸'),
              h('span', { className: 'pdfkb-topic-title' }, group.name || t('topicUntitled')),
              h('span', { className: 'pdfkb-topic-meta' }, meta),
            ),
            open
              ? h(
                  'div',
                  { className: 'pdfkb-topic-body' },
                  group.chunks.map(chunk =>
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
              : null,
          )
        }),
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

    /** Background jobs: what was queued, what is done, and what failed. */
    function TasksPane({ jobs, t, onCancel, onDismiss, onOpen }) {
      if (!jobs.length) return h('p', { className: 'pdfkb-empty' }, t('jobsEmpty'))
      return h(
        'div',
        { className: 'pdfkb-tasks' },
        jobs.map(job => {
          const progress = job.progress ?? { total: job.total, done: job.done, ratio: 0 }
          const active = !FINISHED.has(job.state)
          const percent = Math.round(Math.min(1, Math.max(0, Number(progress.ratio) || 0)) * 100)
          return h(
            'article',
            { key: job.id, className: 'pdfkb-task', 'data-state': job.state },
            h(
              'div',
              { className: 'pdfkb-task-head' },
              h('span', { className: 'pdfkb-task-title', title: job.title }, job.title),
              h('span', { className: 'pdfkb-task-state' }, t(`jobState_${job.state}`)),
            ),
            h('div', { className: 'pdfkb-bar' }, h('div', { className: 'pdfkb-bar-fill', style: { width: `${percent}%` } })),
            h(
              'div',
              { className: 'pdfkb-task-meta' },
              h(
                'span',
                null,
                job.kind === 'ocr'
                  ? format(t('jobPages'), { n: progress.done, m: progress.total })
                  : format(t('jobProgress'), { done: progress.done, total: progress.total }),
              ),
              job.failed ? h('span', { className: 'pdfkb-task-bad' }, format(t('jobFailedCount'), { n: job.failed })) : null,
              h(
                'button',
                {
                  className: 'pdfkb-btn pdfkb-btn-quiet',
                  type: 'button',
                  // While the runner is inside the job the request is recorded but the
                  // work only stops at the next checkpoint, so say so instead of repeating
                  // an apparently dead click.
                  disabled: job.state === 'cancelling',
                  onClick: () => (active ? onCancel(job.id) : onDismiss(job.id)),
                },
                job.state === 'cancelling' ? t('jobState_cancelling') : active ? t('jobCancel') : t('jobDismiss'),
              ),
            ),
            job.items.length > 1
              ? h(
                  'ul',
                  { className: 'pdfkb-task-items' },
                  job.items.map(item =>
                    h(
                      'li',
                      { key: item.index, className: 'pdfkb-task-item' },
                      h('span', { className: 'pdfkb-task-name', title: item.name }, item.name),
                      h(
                        'span',
                        { className: 'pdfkb-task-item-state' },
                        item.state === 'done' && item.documentId
                          ? h(
                              'button',
                              { className: 'pdfkb-link', type: 'button', onClick: () => onOpen(item.documentId) },
                              t('jobOpen'),
                            )
                          : item.error
                            ? h('span', { className: 'pdfkb-task-bad', title: item.error }, t(`jobItem_${item.state}`))
                            : t(`jobItem_${item.state}`),
                      ),
                    ),
                  ),
                )
              : null,
          )
        }),
      )
    }

    function PanelPage({ t }) {
      const [documents, setDocuments] = useState([])
      const [totals, setTotals] = useState({ documents: 0, pages: 0, chunks: 0, topics: 0 })
      const [selected, setSelected] = useState(undefined)
      const [detail, setDetail] = useState(undefined)
      const [tab, setTab] = useState('content')
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [question, setQuestion] = useState('')
      const [result, setResult] = useState(undefined)
      const [asking, setAsking] = useState(false)
      const [dragging, setDragging] = useState(false)
      const [jobs, setJobs] = useState([])
      const [groups, setGroups] = useState([])
      const [collapsedGroups, setCollapsedGroups] = useState({})
      const [uploadState, setUploadState] = useState(undefined)
      const [ocrInfo, setOcrInfo] = useState(undefined)
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
          setGroups(body.groups ?? [])
          setTotals(body.totals ?? { documents: 0, pages: 0, chunks: 0, topics: 0 })
          if (body.ocr) setOcrInfo(body.ocr)
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

      const loadJobs = useCallback(async () => {
        const body = await call('/jobs')
        if (body.ok) setJobs(body.jobs ?? [])
        return body
      }, [])

      const wasBusyRef = useRef(false)
      useEffect(() => {
        void loadJobs()
        // Poll while the panel is open: jobs keep running Host-side, so the list
        // has to catch up on work that finished after the tab was hidden.
        const timer = setInterval(() => {
          void loadJobs().then(async body => {
            const busy = Boolean(body?.active)
            if (!busy) {
              await loadState()
              // A finished job may have added text to the open document (OCR writes page
              // text in place), so the detail pane has to be refetched once work settles.
              if (wasBusyRef.current && selected) void loadDocument(selected)
            }
            wasBusyRef.current = busy
          })
        }, 2500)
        return () => clearInterval(timer)
      }, [loadJobs, loadState, loadDocument, selected])

      useEffect(() => {
        if (!selected && documents.length) void loadDocument(documents[0].id)
      }, [documents, selected, loadDocument])

      const postJson = useCallback(
        async (suffix, payload) => {
          const body = await call(suffix, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload ?? {}),
          })
          if (!body.ok) setError(describe(body))
          await loadState()
          return body
        },
        [describe, loadState],
      )

      const createGroup = useCallback(async () => {
        const name = window.prompt(t('groupNamePrompt'), '')
        if (!name || !name.trim()) return
        await postJson('/group-create', { name })
      }, [postJson, t])

      const renameGroup = useCallback(
        async group => {
          const name = window.prompt(t('groupRenamePrompt'), group.name)
          if (!name || !name.trim()) return
          await postJson('/group-rename', { id: group.id, name })
        },
        [postJson, t],
      )

      const deleteGroup = useCallback(
        async group => {
          if (!window.confirm(format(t('groupDeleteConfirm'), { name: group.name }))) return
          await postJson('/group-delete', { id: group.id })
        },
        [postJson, t],
      )

      const assignGroup = useCallback(
        async (doc, groupId) => {
          await postJson('/group-assign', { document: doc.id, group: groupId })
        },
        [postJson],
      )

      const upload = useCallback(
        async fileList => {
          const picked = Array.from(fileList ?? [])
          const files = picked.filter(file => file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)))
          if (!files.length) {
            // A button that swallows the click looks broken, so name the reason.
            if (picked.length) setError(t('errNotPdf'))
            return
          }
          setError('')
          setNotice('')
          setTab('tasks')
          const created = await call('/jobs/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              files: files.map(file => ({ name: file.name, size: file.size })),
              autoOcr: true,
            }),
          })
          if (!created.ok || !created.job) {
            setError(describe(created))
            return
          }
          const job = created.job
          setJobs(previous => [job, ...previous])
          for (const [index, file] of files.entries()) {
            setUploadState({ index, total: files.length, name: file.name, ratio: 0 })
            const body = await sendFile(
              `/job-file?job=${encodeURIComponent(job.id)}&index=${index}&name=${encodeURIComponent(file.name)}`,
              file,
              ratio => setUploadState(current => (current && current.index === index ? { ...current, ratio } : current)),
            )
            if (!body.ok) {
              // A cancel from the task list lands here: stop uploading quietly rather
              // than reporting a failure the user caused on purpose.
              if (body.code === 'KB_CANCELLED') break
              setError(describe(body))
              break
            }
          }
          setUploadState(undefined)
          await loadJobs()
          await loadState()
        },
        [describe, loadJobs, loadState, t],
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

      const uploading = Boolean(uploadState)
      const activeJobs = jobs.filter(job => !FINISHED.has(job.state))
      const ocrBusy = Boolean(
        detail && jobs.some(job => job.kind === 'ocr' && !FINISHED.has(job.state) && job.items[0]?.documentId === detail.id),
      )

      /** Hand a whole scan to the Host queue: recognition outlives the panel. */
      const queueOcr = useCallback(
        async doc => {
          if (!doc?.id) return
          setError('')
          const body = await call('/jobs/ocr', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: doc.id }),
          })
          if (!body.ok) {
            setError(describe(body))
            return
          }
          setNotice(body.job ? t('ocrQueued') : t('ocrComplete'))
          setTab('tasks')
          await loadJobs()
        },
        [describe, loadJobs, t],
      )

      const cancelJob = useCallback(
        async id => {
          const body = await call('/job-cancel', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          })
          if (!body.ok) setError(describe(body))
          await loadJobs()
        },
        [describe, loadJobs],
      )

      const dismissJob = useCallback(
        async id => {
          const body = await call('/job-delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          })
          if (!body.ok) setError(describe(body))
          await loadJobs()
        },
        [describe, loadJobs],
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
          const dropped = event.dataTransfer?.files
          if (dropped && dropped.length) void upload(dropped)
        },
      }

      const stats = format(t('total'), {
        docs: totals.documents,
        pages: totals.pages,
        topics: totals.topics ?? 0,
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
            ocrInfo
              ? h(
                  'p',
                  { className: 'pdfkb-stats' },
                  ocrInfo.tesseract ? t('ocrBackendLocal') : ocrInfo.engine === 'tesseract' ? t('ocrBackendNone') : t('ocrBackendVision'),
                )
              : null,
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
              uploading ? t('uploading') : t('uploadMany'),
            ),
            h('input', {
              ref: inputRef,
              type: 'file',
              accept: 'application/pdf,.pdf',
              multiple: true,
              style: { display: 'none' },
              onChange: event => {
                // Snapshot first: assigning `value` empties this live FileList, so reading
                // it inside upload() would hand back nothing and the button would look dead.
                const picked = Array.from(event.target.files ?? [])
                event.target.value = ''
                void upload(picked)
              },
            }),
          ),
        ),
        error ? h('p', { className: 'pdfkb-error', style: { marginTop: '10px' } }, error) : null,
        !error && notice
          ? h('p', { className: 'pdfkb-notice', style: { marginTop: '10px' } }, notice)
          : null,
        uploadState
          ? h(
              'p',
              { className: 'pdfkb-notice', style: { marginTop: '10px' } },
              format(t('uploadProgress'), {
                name: uploadState.name,
                n: uploadState.index + 1,
                m: uploadState.total,
                p: Math.round(uploadState.ratio * 100),
              }),
            )
          : null,
        h(
          'div',
          { className: 'pdfkb-body' },
          h(
            'aside',
            { className: 'pdfkb-list' },
            h(
              'div',
              { className: 'pdfkb-list-head' },
              h('span', { className: 'pdfkb-list-title' }, t('documents')),
              h(
                'button',
                {
                  className: 'pdfkb-group-new',
                  type: 'button',
                  title: t('newGroup'),
                  onClick: () => void createGroup(),
                },
                `+ ${t('newGroup')}`,
              ),
            ),
            [
              ...groups.map(group => ({
                key: group.id,
                id: group.id,
                name: group.name,
                group,
                docs: documents.filter(doc => doc.group === group.id),
              })),
              {
                key: '',
                id: '',
                name: t('groupUngrouped'),
                group: undefined,
                docs: documents.filter(doc => !doc.group),
              },
            ]
              .filter(section => section.id || section.docs.length || !documents.length)
              .map(section => {
                const open = !collapsedGroups[section.key || '__ungrouped']
                const toggle = () =>
                  setCollapsedGroups(previous => ({
                    ...previous,
                    [section.key || '__ungrouped']: !previous[section.key || '__ungrouped'],
                  }))
                return h(
                  'section',
                  { className: 'pdfkb-group', key: section.key || 'ungrouped' },
                  h(
                    'div',
                    { className: 'pdfkb-group-head' },
                    h(
                      'button',
                      {
                        className: 'pdfkb-group-toggle',
                        type: 'button',
                        'aria-expanded': open ? 'true' : 'false',
                        onClick: toggle,
                      },
                      h('span', { className: 'pdfkb-group-caret' }, open ? '▾' : '▸'),
                      h('span', { className: 'pdfkb-group-name', title: section.name }, section.name),
                      h('span', { className: 'pdfkb-group-count' }, format(t('groupCount'), { n: section.docs.length })),
                    ),
                    section.group
                      ? h(
                          'button',
                          {
                            className: 'pdfkb-group-act',
                            type: 'button',
                            title: t('groupRename'),
                            onClick: () => void renameGroup(section.group),
                          },
                          '✎',
                        )
                      : null,
                    section.group
                      ? h(
                          'button',
                          {
                            className: 'pdfkb-group-act',
                            type: 'button',
                            title: t('groupDelete'),
                            onClick: () => void deleteGroup(section.group),
                          },
                          '🗑',
                        )
                      : null,
                  ),
                  open
                    ? section.docs.length
                      ? section.docs.map(doc =>
                          h(DocumentRow, {
                            key: doc.id,
                            doc,
                            active: doc.id === selected,
                            t,
                            groups,
                            onSelect: id => void loadDocument(id),
                            onDelete: row => void remove(row),
                            onGroup: (row, groupId) => void assignGroup(row, groupId),
                          }),
                        )
                      : h('p', { className: 'pdfkb-group-empty' }, t('groupEmpty'))
                    : null,
                )
              }),
          ),
          h(
            'main',
            { className: 'pdfkb-main' },
            h(
              'nav',
              { className: 'pdfkb-tabs' },
              [
                ['content', t('tabContent')],
                ['knowledge', t('tabKnowledge')],
                ['ask', t('tabAsk')],
                ['tasks', activeJobs.length ? format(t('tabTasksBusy'), { n: activeJobs.length }) : t('tabTasks')],
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
              tab === 'tasks'
                ? h(TasksPane, {
                    jobs,
                    t,
                    onCancel: id => void cancelJob(id),
                    onDismiss: id => void dismissJob(id),
                    onOpen: id => {
                      setTab('content')
                      void loadDocument(id)
                    },
                  })
                : tab === 'ask'
                  ? h(AskPane, { t, onAsk: () => void ask(), asking, result, error: '', question, setQuestion })
                  : documents.length
                    ? detail
                      ? tab === 'content'
                        ? h(ContentPane, {
                            detail,
                            t,
                            onOcr: doc => void queueOcr(doc),
                            onStopOcr: () => {
                              const job = jobs.find(
                                entry => entry.kind === 'ocr' && !FINISHED.has(entry.state) && entry.items[0]?.documentId === detail.id,
                              )
                              if (job) void cancelJob(job.id)
                            },
                            ocrBusy,
                          })
                        : h(KnowledgePane, { detail, t })
                      : h(
                          'div',
                          { className: 'pdfkb-empty' },
                          h('h2', null, t('noSelection')),
                          h('p', null, t('noSelectionBody')),
                        )
                    : h(
                        'div',
                        { className: 'pdfkb-empty' },
                        h('h2', null, loading ? '…' : t('emptyTitle')),
                        h('p', null, t('emptyBody')),
                        h(
                          'button',
                          { className: 'pdfkb-btn pdfkb-btn-primary', type: 'button', onClick: () => inputRef.current?.click() },
                          t('uploadMany'),
                        ),
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
