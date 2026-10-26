export interface Diagnostic { code: string; message: string; recovery: string }
export class AndroidProblem extends Error {
  constructor(readonly diagnostic: Diagnostic) { super(`[${diagnostic.code}] ${diagnostic.message}。${diagnostic.recovery}`); this.name = 'AndroidProblem' }
}
export function diagnoseError(error: unknown): Diagnostic {
  if (error instanceof AndroidProblem) return error.diagnostic
  const text = String((error as Error)?.message ?? error)
  const rules: [RegExp, string, string, string][] = [
    [/could not read ok from ADB Server|failed to start daemon|cannot connect to daemon|cannot bind to .*5037|smartsocket.*listener/i, 'ADB_SERVER_START_FAILED', '电脑端 ADB 服务启动失败', '先刷新设备列表；若持续失败，检查 ADB 服务端口是否被其他程序占用、系统是否拦截 ADB，以及连接设置是否仍指定旧版 ADB。不要反复重启或关闭其他应用的共享服务'],
    [/剪贴板.*超时/,'CLIPBOARD_UNAVAILABLE','手机未返回剪贴板文字','内容可能为空或受系统限制；先在手机复制文字，再读取剪贴板'],
    [/TASK_LIMIT|任务.*上限|任务.*超时/, 'TASK_LIMIT', '任务已达到执行限额', '查看任务记录；确认已完成范围后，在聊天中发起新任务'],
    [/未授权|unauthorized|authorizing/i, 'DEVICE_UNAUTHORIZED', '手机尚未授权 USB 调试', '解锁手机并确认连接电脑的调试授权，然后刷新设备'],
    [/offline/i, 'DEVICE_OFFLINE', '手机处于离线状态', '检查 USB 线和手机状态，重新连接后刷新设备'],
    [/未连接|未发现手机|No authorized device/i, 'NO_DEVICE', '未发现可用手机', '使用支持数据传输的 USB 线，开启手机开发者选项中的 USB 调试并解锁授权；Windows 仍未识别时检查设备管理器中的手机 USB 驱动，然后刷新设备'],
    [/INJECT_EVENTS|输入注入|注入权限|Could not inject/i, 'INPUT_PERMISSION', '手机拒绝输入控制', '在手机上检查 USB 调试的安全选项，再重新连接'],
    [/图片输入能力|视觉模型|image.*input/i, 'MODEL_IMAGE_UNSUPPORTED', '当前模型未声明图片输入能力', '使用界面元素读取；需要识图时选择支持图片的模型'],
    [/观察.*失效|观察超过|旋转|控制状态已变化/, 'STALE_OBSERVATION', '界面观察已失效', '重新观察手机，再使用新返回的元素和观察标识'],
    [/已聚焦|聚焦的输入框/, 'FIELD_NOT_FOCUSED', '没有可确认焦点的输入框', '先点击目标输入框并重新观察，再输入文字'],
    [/另一台手机/, 'DEVICE_BUSY', '已连接另一台手机', '断开当前手机后明确选择目标设备'],
    [/屏幕收到新的输入/, 'INPUT_INTERRUPTED', '本次动作因新的屏幕输入而中断', '直接重新观察当前画面后继续，无需切换控制权'],
    [/\[CANCELLED\]|AbortError|aborted|用户已|用户.*停止.*任务|任务已结束|任务已取消|已中断/i, 'CANCELLED', '操作已取消', '重新发起任务时先观察当前手机状态'],
    [/Timeout|timed out|超时/i, 'TIMEOUT', '操作等待超时', '先观察实际状态再决定重试，避免重复输入或点击'],
    [/视频.*结束|连接中断|ECONNRESET|EPIPE|连接已关闭|socket/i, 'CONNECTION_LOST', '手机连接已中断', '断开后重新连接，再重新观察'],
  ]
  for (const [pattern, code, message, recovery] of rules) if (pattern.test(text)) return { code, message, recovery }
  return { code: 'OPERATION_FAILED', message: text.slice(0, 400) || '手机操作失败', recovery: '查看操作记录和当前画面，确认后重新观察再继续' }
}
