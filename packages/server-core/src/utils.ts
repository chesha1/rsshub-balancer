// 释放已确定不再使用的响应体；取消失败不能覆盖原有选路或错误结果。
export async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // 超时或流已出错时取消也可能失败，此时保留调用方原本的处理结果。
  }
}

// 统一上游地址格式，拼接请求路径时避免重复斜线。
export function trimSlash(url: string) {
  return url.replace(/\/+$/, '')
}

// 打乱候选顺序但保留输入快照，避免修改共享缓存。
export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// 首页构建产物统一输出到该目录，整个目录都属于本站。
const ASSETS_DIRECTORY = '/_assets'

// 根目录下只有一个路径段、扩展名为图片、图标、样式、脚本或字体的文件属于本站，
// 覆盖浏览器、阅读器和链接预览服务探测的 /favicon.ico、/apple-touch-icon*.png 等地址。
const ROOT_STATIC_FILE_PATTERN =
  /^\/[^/]+\.(?:ico|png|jpe?g|gif|webp|avif|svg|css|m?js|woff2?|ttf|otf|eot)$/i

// 判断请求地址是否属于本站资源，命中的请求由共享路由在进入 RSS 代理前本地返回 404。
// 参数使用 Hono 的 c.req.path，与路由匹配保持同一路径：非保留字符已解码，编码斜杠、双重编码和非法编码保持原样；
// 这里不再自行解码、合并斜杠或删除尾随斜杠，归属只由路径决定，不看查询字符串和请求头。
export function isLocalResourcePath(path: string): boolean {
  // 按完整路径段匹配目录，/_assets-other/feed 这类同前缀路径仍属于上游业务。
  if (path === ASSETS_DIRECTORY || path.startsWith(`${ASSETS_DIRECTORY}/`)) {
    return true
  }
  // 嵌套路径（如 /example/user.png）、尾随斜杠和双斜杠都不匹配，继续交给代理。
  return ROOT_STATIC_FILE_PATTERN.test(path)
}
