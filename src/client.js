window.__ModuleLoader__.load({
  id: 'dsh-android',
  factory(require) {
    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        let dispose
        let cancelled = false
        ctx.effect(() => () => { cancelled = true; dispose?.() })
        import('/x-android/ui.js?v=' + Date.now()).then(mod => {
          if (!cancelled) dispose = mod.mount(ctx, require('react'))
        }).catch(error => console.error('[dsh-android] UI load failed', error))
      },
    }
  },
})
