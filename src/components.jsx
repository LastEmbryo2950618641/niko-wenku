import { useEffect, useId, useRef, useState } from 'react';
import { BookOpen, Check, Download, FileText, FolderOpen, Plus, Upload, X } from 'lucide-react';
import { api, appUrl, bookUrl, bytes, date, navigate, readBook, words } from './lib';
import { languageLabel } from '../shared/language.mjs';
import { LaceDivider, RibbonBow } from './library-ornaments';

export function Cover({ book, large = false }) {
  return book.coverUrl ? <img className={'cover-image ' + (large ? 'cover-large' : '')} src={appUrl(book.coverUrl)} alt={book.title + '封面'} loading="lazy"/> :
    <div className={'type-cover ' + (large ? 'cover-large' : '')}><span className="cover-edition">{book.category || '本地藏书'}</span><span className="cover-rule"/><strong>{book.title}</strong><span className="cover-author">{book.author}</span><BookOpen size={22} strokeWidth={1}/></div>;
}
export function Modal({ title, onClose, children, wide = false }) {
  const ref = useRef(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} aria-labelledby={titleId} className={'modal ' + (wide ? 'modal-wide' : '')} onCancel={event => { event.preventDefault(); closeRef.current(); }} onClick={event => { if (event.target === event.currentTarget) closeRef.current(); }}>
    <div className="modal-inner"><header className="modal-header"><h2 id={titleId}><RibbonBow/>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={20}/></button></header><LaceDivider className="modal-lace"/>{children}</div>
  </dialog>;
}
export function ImportDialog({ onClose, onPublished, libraryPath }) {
  const [files, setFiles] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  async function publish() {
    setError(''); setBusy(true);
    try {
      const metadataFile = files.find(file => file.name.endsWith('.json'));
      if (!metadataFile) throw new Error('请选择 book.json（或其他 JSON 元数据文件）');
      if (metadataFile.size > 1048576) throw new Error('JSON 元数据不能超过 1 MB');
      const manifest = JSON.parse((await metadataFile.text()).replace(/^\uFEFF/, ''));
      const payload = [];
      for (const file of files.filter(file => file !== metadataFile)) {
        if (file.size > 128 * 1024 * 1024) throw new Error('单个文件不能超过 128 MB');
        const content = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < content.length; offset += 32768) binary += String.fromCharCode(...content.subarray(offset, offset + 32768));
        payload.push({ name: file.name, base64: btoa(binary) });
      }
      await api('/api/publish', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Archive-Client': 'local-web' }, body: JSON.stringify({ manifest, files: payload }) });
      onPublished(manifest.title);
    } catch (reason) { setError(reason instanceof SyntaxError ? 'JSON 格式有误，请检查元数据文件' : reason.message); }
    finally { setBusy(false); }
  }
  return <Modal title="导入书籍" onClose={busy ? () => {} : onClose}>
    <p className="modal-intro">一份元数据，一本完整书稿。发布后即刻出现在书库。</p>
    <button className="drop-zone" onClick={() => input.current.click()} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); setFiles([...event.dataTransfer.files]); setError(''); }}>
      <span className="drop-icon"><Upload size={25} strokeWidth={1.5}/></span><strong>将 JSON 和配套文件一起拖到这里</strong><span>或点击选择 · TXT / MD 正文，可附带封面与其他格式</span>
    </button>
    <input ref={input} type="file" multiple className="visually-hidden" aria-label="选择元数据和书稿文件" onChange={event => { setFiles([...event.target.files]); setError(''); }}/>
    {files.length > 0 && <div className="import-files">{files.map(file => <div key={file.name}><FileText size={16}/><span>{file.name}</span><small>{bytes(file.size)}</small></div>)}</div>}
    <div className="import-path"><FolderOpen size={18}/><div><strong>也可以直接放入书库目录</strong><code>{libraryPath || 'library/'}</code><span>每本书一个子目录，包含 book.json 和正文；页面每 5 秒自动刷新。</span></div></div>
    <a className="text-link" href={appUrl('/book-template.json')} download><Download size={15}/>下载完整元数据模板</a>
    {error && <p className="form-error" role="alert">{error}</p>}
    <footer className="modal-actions"><button className="button secondary" onClick={onClose} disabled={busy}>取消</button><button className="button primary" onClick={publish} disabled={busy || !files.length}>{busy ? '正在发布…' : <><Plus size={16}/>发布到书库</>}</button></footer>
  </Modal>;
}
export function BookDetails({ id, onClose, progress }) {
  const [book, setBook] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    api(bookUrl(id), { signal: controller.signal }).then(setBook).catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [id]);
  return <Modal title="书籍资料" onClose={onClose} wide>
    {error ? <p className="form-error">{error}</p> : !book ? <div className="loading-state">正在整理书籍资料…</div> : <>
      <div className="detail-heading"><Cover book={book}/><div><span className="muted-label">{book.category}</span><h1>{book.title}</h1>{book.originalTitle && <p className="original-title">{book.originalTitle}</p>}<p className="detail-author">{book.author}<span> 著</span></p><div className="tag-list">{book.tags.map(tag => <span key={tag}>{tag}</span>)}<span className="status-label"><Check size={13}/>{book.status}</span></div><div className="detail-actions"><button className="button primary" onClick={() => readBook(book.id, progress?.chapter || 0)}><BookOpen size={16}/>{progress ? '继续阅读' : '开始阅读'}</button><a className="button secondary" href={appUrl(book.downloadUrl)}><Download size={16}/>下载全文</a></div></div></div>
      <div className="detail-description"><h3>内容介绍</h3><p>{book.description || '这本书还没有填写介绍，可在 book.json 中补充 description 字段。'}</p></div>
      <dl className="metadata-grid">{[['作者', book.author], ['译者', book.translator], ['插画', book.illustrator], ['出版方', book.publisher], ['语言', languageLabel(book.language)], ['状态', book.status], ['资料更新时间', date(book.updatedAt)], ['入库时间', date(book.addedAt)], ['全文字数', words(book.wordCount)], ['目录', book.chapterCount + ' 章'], ['文件大小', bytes(book.bytes)], ['文本编码', book.encoding], ['出版年份', book.publishedYear || '未提供'], ['来源', book.source.name || '本地导入']].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || '未提供'}</dd></div>)}</dl>
      <details className="raw-metadata"><summary>查看全部元数据与文件</summary><pre>{JSON.stringify(book.metadata, null, 2)}</pre><div className="attachment-list">{book.files.map(file => <a href={appUrl(file.url)} key={file.kind}><FileText size={15}/>{file.name}<span>{bytes(file.bytes)}</span><Download size={15}/></a>)}</div></details>
      <div className="detail-chapters"><h3>章节目录 <small>{book.chapters.length} 章</small></h3><div>{book.chapters.map(item => <button key={item.index} onClick={() => readBook(book.id, item.index)}>{item.title}</button>)}</div></div>
    </>}
  </Modal>;
}
