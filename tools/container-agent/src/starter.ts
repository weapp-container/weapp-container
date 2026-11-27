export function starterFiles(name: string): Record<string, string> {
  const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
  return {
    'package.json': json({
      name: 'company-mini-program',
      private: true,
      scripts: { prepare: 'wv prepare' },
      devDependencies: { 'weapp-vite': '7.5.0' },
    }),
    'project.config.json': json({
      compileType: 'miniprogram',
      srcMiniprogramRoot: 'src/',
      miniprogramRoot: 'dist/',
      appid: 'touristappid',
    }),
    'vite.config.ts': `import { defineConfig } from 'weapp-vite'

export default defineConfig({
  weapp: { srcRoot: 'src' },
})
`,
    '.gitignore': 'node_modules/\ndist/\n.weapp-container/\n.weapp-vite/\n',
    'src/app.json': json({
      pages: ['pages/index/index'],
      window: { navigationBarTitleText: name, navigationBarBackgroundColor: '#eef4f1', navigationBarTextStyle: 'black' },
    }),
    'src/app.js': 'App({})\n',
    'src/app.wxss': `page { background: #eef4f1; color: #12362d; }
`,
    'src/pages/index/brand.js': `export default ${json({ name, logo: '', summary: '在这里介绍你的业务，并连接宿主应用提供的服务。' })}`,
    'src/pages/index/index.js': `import brand from './brand.js'

Page({
  data: { brand, loading: false, displayName: '', error: '' },
  onUnload() {
    this.unloaded = true
  },
  async loadProfile() {
    if (this.data.loading) return
    this.setData({ loading: true, displayName: '', error: '' })
    try {
      if (typeof weappContainer === 'undefined') throw new Error('请在支持宿主调用的预览或应用中打开')
      const result = await weappContainer.invoke('company.getProfile', {}, { timeout: 5000 })
      if (typeof result?.displayName !== 'string' || !result.displayName.trim()) {
        throw new Error('宿主返回的名称无效')
      }
      if (!this.unloaded) this.setData({ displayName: result.displayName })
    } catch (error) {
      if (!this.unloaded) this.setData({ error: error?.message || '暂时无法获取资料，请重试' })
    } finally {
      if (!this.unloaded) this.setData({ loading: false })
    }
  },
})
`,
    'src/pages/index/index.wxml': `<view class="page">
  <image wx:if="{{brand.logo}}" class="logo" src="{{brand.logo}}" mode="aspectFit" />
  <view class="title" id="brand-title">{{brand.name}}</view>
  <view class="summary">{{brand.summary}}</view>
  <view class="profile">
    <button id="load-profile" bindtap="loadProfile" loading="{{loading}}" disabled="{{loading}}">{{error ? '重试' : '获取宿主用户资料'}}</button>
    <view wx:if="{{displayName}}" id="profile-name" class="result">{{displayName}}</view>
    <view wx:if="{{error}}" id="profile-error" class="error">{{error}}</view>
  </view>
</view>
`,
    'src/pages/index/index.wxss': `.page { padding: 80rpx 48rpx; }
.logo { display: block; width: 120rpx; height: 120rpx; margin-bottom: 36rpx; }
.title { font-size: 52rpx; font-weight: 700; line-height: 1.2; }
.summary { margin-top: 24rpx; max-width: 540rpx; font-size: 28rpx; line-height: 1.6; }
.profile { margin-top: 60rpx; padding: 28rpx; background: #fff; border-radius: 20rpx; }
.profile button { background: #155845; color: #fff; font-size: 28rpx; }
.result, .error { margin-top: 20rpx; font-size: 26rpx; }
.error { color: #87391e; }
`,
    'preview/host-fixtures.json': json({ 'company.getProfile': { resolve: { displayName: '预览用户' } } }),
    'README.md': `# 小程序定制 / Customize this mini-program

1. 运行 \`npm install\` 安装编译器 / Install the compiler with \`npm install\`.
2. 在 \`src/app.json\` 修改导航栏，在 \`src/pages/index/brand.js\` 修改首页标题和介绍。将品牌图片放到 \`src/assets/\`，把 \`logo\` 设为 \`/assets/你的文件名.png\`。在 \`src/app.wxss\` 和首页 \`index.wxss\` 修改颜色。
3. 运行 \`weapp-container-agent preview start --project . --simulator-bin /path/to/bin/weapp-simulator --host-fixtures preview/host-fixtures.json\`，打开输出的 Web 地址。使用 \`preview stop --project .\` 结束预览。
4. 运行 \`weapp-container-agent build --project . --out ./portable-pack\`，将生成的整个目录交给宿主 SDK。

Edit the navigation in \`src/app.json\` and the home page in \`src/pages/index/brand.js\`. Put your logo in \`src/assets/\` and set \`logo\` to its app-relative path, such as \`/assets/logo.png\`. Edit colors in \`src/app.wxss\` and the page stylesheet.

The preview fixture supplies a sample result for \`company.getProfile\`. Your mobile host registers that method before loading the pack and returns \`{ displayName }\`.
`,
  }
}
