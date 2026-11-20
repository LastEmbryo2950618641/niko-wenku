import test from 'node:test';
import assert from 'node:assert/strict';
import { ciweimaoAccessNotice } from '../src/ciweimao-notice.js';

test('book-list verification pause shows its page checkpoint and next steps', () => {
  const notice = ciweimaoAccessNotice({
    status: 'access_required',
    message: '书库继续翻页需要官网人工验证，扫描断点已保存',
    scan: { nextPage: 20, message: '书库继续翻页需要官网人工验证，扫描断点已保存' }
  });

  assert.equal(notice.title, '需要完成书库翻页验证');
  assert.match(notice.message, /第 20 页/);
  assert.match(notice.message, /更新登录状态中的 Cookie 后重新启动同步/);
  assert.match(notice.message, /扫描断点保留/);
  assert.equal(notice.url, 'https://www.ciweimao.com/book_list/0-0-0-0-0-0/quanbu/20');
  assert.equal(notice.linkText, '打开刺猬猫第 20 页');
});

test('missing booklistCode notice links directly to the page that needs verification', () => {
  const message = '缺少书库翻页验证 Cookie booklistCode，请在官网完成翻页验证后重新导入，扫描断点已保存';
  const notice = ciweimaoAccessNotice({
    status: 'access_required',
    message,
    scan: { nextPage: 23, message }
  });

  assert.equal(notice.url, 'https://www.ciweimao.com/book_list/0-0-0-0-0-0/quanbu/23');
  assert.equal(notice.linkText, '打开刺猬猫第 23 页');
});

test('other access restrictions keep their server message in a visible notice', () => {
  const notice = ciweimaoAccessNotice({
    status: 'access_required',
    message: '正文接口需要人工验证，同步已暂停',
    scan: { nextPage: 3, message: '' }
  });

  assert.equal(notice.title, '刺猬猫需要人工处理');
  assert.equal(notice.message, '正文接口需要人工验证，同步已暂停');
});

test('ordinary task states do not show an access notice', () => {
  assert.equal(ciweimaoAccessNotice({ status: 'syncing' }), null);
});
