import { useEffect, useState } from 'react';
import { Check, MoonStar, Sun } from 'lucide-react';
import { Modal } from './components';
import { readStore, writeStore } from './lib';

const skinKey = 'library-skin';
const skins = [
  { id: 'night', name: '默认 · 星夜', description: '夜景与浅蓝，点缀柔粉', Icon: MoonStar },
  { id: 'peach', name: '白桃', description: '白色与樱粉，轻盈明亮', Icon: Sun },
];
const storedSkin = () => readStore(skinKey, 'night') === 'peach' ? 'peach' : 'night';

export function useLibrarySkin() {
  const [skin, setSkin] = useState(storedSkin);
  useEffect(() => {
    const sync = event => { if (event.key === null || event.key === 'wenku:v1:' + skinKey) setSkin(storedSkin()); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  function selectSkin(id) {
    if (!skins.some(item => item.id === id)) return;
    setSkin(id);
    writeStore(skinKey, id);
  }
  return [skin, selectSkin];
}

export function LibrarySkinDialog({ skin, onSelect, onClose }) {
  return <Modal title="书库皮肤" onClose={onClose}>
    <p className="modal-intro">选择喜欢的氛围，即刻预览。</p>
    <div className="skin-options" role="group" aria-label="选择书库皮肤">
      {skins.map(({ id, name, description, Icon }) => <button key={id} type="button" className="skin-option" aria-pressed={skin === id} onClick={() => onSelect(id)}>
        <span className={'skin-preview skin-preview-' + id} aria-hidden="true"><span className="skin-preview-sidebar"><i/><i/><i/></span><span className="skin-preview-main"><i/><span className="skin-preview-books"><i/><i/><i/></span></span></span>
        <span className="skin-option-heading"><Icon size={17} aria-hidden="true"/><strong>{name}</strong>{skin === id && <Check size={16} className="skin-selected-check" aria-hidden="true"/>}</span>
        <span className="skin-option-description">{description}</span>
        <span className="skin-option-state">{skin === id ? '正在使用' : '点击切换'}</span>
      </button>)}
    </div>
    <p className="skin-note">自动记住此浏览器的选择，阅读器保留独立的主题设置。</p>
    <footer className="modal-actions"><button type="button" className="button primary" onClick={onClose}><Check size={15} aria-hidden="true"/>完成</button></footer>
  </Modal>;
}
