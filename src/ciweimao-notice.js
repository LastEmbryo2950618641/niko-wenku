export function ciweimaoAccessNotice(state) {
  if (state?.status !== 'access_required') return null;

  const reason = state.scan?.message || state.message || '';
  if (reason.includes('书库继续翻页需要官网人工验证') || reason.includes('booklistCode')) {
    const page = state.scan?.nextPage || 20;
    return {
      title: '需要完成书库翻页验证',
      message: `请在已登录的刺猬猫浏览器完成第 ${page} 页验证，更新登录状态中的 Cookie 后重新启动同步。任务已暂停，扫描断点保留在第 ${page} 页。`,
      url: `https://www.ciweimao.com/book_list/0-0-0-0-0-0/quanbu/${page}`,
      linkText: `打开刺猬猫第 ${page} 页`
    };
  }

  return {
    title: '刺猬猫需要人工处理',
    message: state.message || '任务已暂停并保留进度。请检查登录状态或稍后重试。'
  };
}
