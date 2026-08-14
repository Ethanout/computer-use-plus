'use strict';

const SERVER_INFO = {
  name: 'computer-use-plus',
  version: '0.1.0'
};

const TOOLS = [
  {
    name: 'agent.run',
    description: '高层快速入口：给出目标和窗口作用域，由本地 Agent 选择 shortcut、UIA/OCR/视觉或快速 AI 并连续执行，返回紧凑结果。',
    inputSchema: {
      type: 'object', required: ['goal'],
      properties: {
        goal: { type: 'string', minLength: 1, maxLength: 4000 },
        window: { type: 'string', description: '明确的窗口 ID；优先于 windowScope。' },
        windowScope: {
          oneOf: [
            { type: 'string', minLength: 1, description: '同时模糊匹配进程、标题或窗口类名。' },
            { type: 'object', properties: { process: { type: 'string' }, title: { type: 'string' }, className: { type: 'string' } }, additionalProperties: false }
          ]
        },
        shortcut_id: { type: 'string' },
        params: { type: 'object', additionalProperties: true },
        budget: {
          type: 'object',
          properties: {
            maxSeconds: { type: 'number', minimum: 0.05, maximum: 300 },
            maxActions: { type: 'integer', minimum: 1, maximum: 100 },
            maxNodes: { type: 'integer', minimum: 1, maximum: 50 }
          },
          additionalProperties: false
        },
        async: { type: 'boolean', description: '为 true 时立即返回 taskId，并通过 agent.status 查询。' },
        stream: { type: 'boolean' },
        confirm_token: { type: 'string', description: '重新运行相同高风险目标时传回的一次性确认令牌。' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'agent.status',
    description: '读取高层任务的紧凑状态；不返回截图、完整 UI 树或底层动作数组。',
    inputSchema: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } }, additionalProperties: false }
  },
  {
    name: 'agent.cancel',
    description: '取消正在规划、等待或执行的高层任务；已经进入驱动的单个调用会在返回后停止后续动作。',
    inputSchema: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } }, additionalProperties: false }
  },
  {
    name: 'agent.capabilities',
    description: '返回本地 Agent 的非敏感能力、隔离模式和预算上限，不返回 provider 凭据。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'computer.state',
    description: '获取窗口、焦点和运行能力；includeUi=true 时一次返回可执行 UI 节点快照和短期 ref。',
    inputSchema: {
      type: 'object',
      properties: {
        window: { type: 'string', description: '只返回指定窗口的 UI 快照。' },
        includeUi: { type: 'boolean', description: '返回受限的 action-ready UI 节点快照。' },
        scope: { type: 'string', enum: ['focused', 'all'], description: '快照范围；默认 focused。' },
        maxNodes: { type: 'integer', minimum: 1, maximum: 50, description: '每个窗口最多返回的节点数。' },
        includeTransitions: { type: 'boolean', description: '是否返回程序自动记录的最近 UI 转换。' },
        actionSignature: { type: 'string', description: '可选的标准化动作签名，用于复用已验证的预测快照。' },
        predict: { type: 'boolean', description: '是否允许使用预测快照；动作后仍必须验证。' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'computer.inspect',
    description: '按需查询窗口或语义 UI 元素；默认不返回完整 UI 树。',
    inputSchema: {
      type: 'object',
      properties: {
        window: { type: 'string', description: '窗口句柄 ID；省略时返回窗口列表。' },
        mode: { type: 'string', enum: ['auto', 'uia', 'ocr', 'vision'], description: '观察策略；默认 auto。' },
        query: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            role: { type: 'string' },
            automationId: { type: 'string' },
            className: { type: 'string' },
            includeOffscreen: { type: 'boolean' },
            limit: { type: 'integer', minimum: 1, maximum: 50 }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'computer.wait',
    description: '等待窗口或 UI 元素出现/消失，支持按标题、进程、角色、文本和 automationId 轮询。',
    inputSchema: {
      type: 'object',
      properties: {
        window: { type: 'string' },
        windowQuery: { type: 'object', properties: { title: { type: 'string' }, process: { type: 'string' }, className: { type: 'string' } }, additionalProperties: false },
        query: { type: 'object', properties: { text: { type: 'string' }, role: { type: 'string' }, automationId: { type: 'string' }, className: { type: 'string' }, includeOffscreen: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
        until: { type: 'string', enum: ['present', 'absent'] },
        timeoutMs: { type: 'integer', minimum: 0, maximum: 60000 },
        pollMs: { type: 'integer', minimum: 50, maximum: 2000 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'computer.screenshot',
    description: '按需获取专用桌面窗口截图；默认只返回坐标元数据，避免增加 token。',
    inputSchema: {
      type: 'object',
      properties: {
        window: { type: 'string', description: '可选窗口句柄；省略时返回最多 20 个窗口。' },
        mode: { type: 'string', enum: ['metadata', 'image'], description: 'image 才返回短期 base64 截图。' },
        coordinateGrid: { type: 'boolean', description: '仅 image 模式可选；在图像上边缘和左边缘绘制窗口相对坐标标尺。' },
        tickPixels: { type: 'integer', minimum: 50, maximum: 500, description: '坐标标尺刻度间距，默认 100 像素。' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'computer.invoke',
    description: '优先入口：执行已保存 shortcut 或一组受限动作；高风险操作返回一次性确认令牌。',
    inputSchema: {
      type: 'object',
      properties: {
        window: { type: 'string' },
        shortcut_id: { type: 'string' },
        params: { type: 'object', additionalProperties: true },
        actions: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object' } },
        confirm_token: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'shortcut.run',
    description: '通过稳定 ID/名称运行已验证 shortcut，不向模型返回完整动作数组。',
    inputSchema: {
      type: 'object', required: ['window', 'shortcut_id'],
      properties: {
        window: { type: 'string' }, shortcut_id: { type: 'string' },
        params: { type: 'object', additionalProperties: true }, confirm_token: { type: 'string' }
      }, additionalProperties: false
    }
  },
  {
    name: 'computer.verify',
    description: '验证窗口、元素、CDP URL 或允许目录中的文件；返回每项断言的 expected、actual、passed。',
    inputSchema: {
      type: 'object',
      properties: {
        window: { type: 'string' }, expectedFingerprint: { type: 'string' }, maxNodes: { type: 'integer', minimum: 1, maximum: 50 },
        assertions: {
          type: 'array', minItems: 1, maxItems: 20,
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['fingerprint', 'element', 'url', 'title', 'file'] },
              equals: { type: 'string' }, includes: { type: 'string' }, matches: { type: 'string' },
              state: { type: 'string', enum: ['present', 'absent'] }, enabled: { type: 'boolean' }, value: { type: 'string' },
              query: { type: 'object', additionalProperties: true }, path: { type: 'string' }, exists: { type: 'boolean' }, minBytes: { type: 'integer', minimum: 0 }
            }, additionalProperties: false
          }
        }
      }, additionalProperties: false
    }
  },
  {
    name: 'computer.cancel',
    description: '取消一个或全部尚未确认的高风险操作。',
    inputSchema: { type: 'object', properties: { confirm_token: { type: 'string' } }, additionalProperties: false }
  },
  {
    name: 'computer.act',
    description: '在指定窗口中执行并验证一组声明式动作。',
    inputSchema: {
      type: 'object',
      required: ['window', 'actions'],
      properties: {
        window: { type: 'string' },
        actions: {
          type: 'array', minItems: 1, maxItems: 100,
          description: '动作支持 click、setValue、hotkey、keys、kbseq、kbops 和 wait；高层等待使用 wait.seconds（秒，可用小数），仅 kbops.at 使用批次起点后的绝对毫秒。',
          items: { type: 'object' }
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'computer.fast',
    description: '可选的快速操作 AI：读取一次紧凑 UI 快照并批量执行当前动作，不写入长期记忆。使用与整理 AI 相同的可选 API key。',
    inputSchema: {
      type: 'object', required: ['window', 'goal'],
      properties: {
        window: { type: 'string' }, goal: { type: 'string' }, shortcut_id: { type: 'string', description: '可选的本地 shortcut/action ID，命中时绕过模型。' },
        params: { type: 'object', description: '高层时间参数使用秒并允许小数；只有 kbops.at 使用毫秒。', additionalProperties: true },
        maxActions: { type: 'integer', minimum: 1, maximum: 100 }, maxNodes: { type: 'integer', minimum: 1, maximum: 50 },
        stream: { type: 'boolean', description: '明确设为 true 时，在首个完整 native tool call 到达后立即执行；仍经过现有权限和高风险确认。' }
      }, additionalProperties: false
    }
  },
  {
    name: 'computer.shortcut',
    description: '由主 AI 显式保存、运行和整理动作链；本地脚本负责作用域隔离、聚类和清理。整理 AI 仅在 useAi=true 时调用。',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['save', 'list', 'run', 'rename', 'merge', 'archive', 'restore', 'organize'] },
        scope: { type: 'string', enum: ['single', 'cross'], description: '默认 single；cross 使用独立的有序窗口路径记忆。' },
        window: { type: 'string', description: 'single 的窗口句柄；run/list 等操作使用。' },
        windows: { type: 'object', description: 'cross 的窗口别名到窗口句柄映射，例如 {browser:"123",explorer:"456"}。', additionalProperties: { type: 'string' } },
        name: { type: 'string', description: 'shortcut 名称，例如“切换资源包”。' },
        newName: { type: 'string' },
        keep: { type: 'string' },
        remove: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        aliases: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        actions: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object' } },
        beforeFingerprint: { type: 'string' },
        afterFingerprint: { type: 'string' },
        params: { type: 'object', description: '模板参数；高层时间值默认使用秒并允许小数，例如 mywait: 0.3；仅 kbops.at 使用毫秒。', additionalProperties: true },
        apply: { type: 'array', items: { type: 'object' }, maxItems: 20 },
        useAi: { type: 'boolean', description: 'organize 时明确设为 true 才调用共享 API key 的整理 AI。' },
        applyAi: { type: 'boolean', description: 'organize 时明确设为 true 才应用整理 AI 返回的 proposal；默认只返回 proposal。' },
        confirm_token: { type: 'string', description: '运行高风险 shortcut 时传回的一次性确认令牌。' },
        maxOperations: { type: 'integer', minimum: 1, maximum: 50 },
        limit: { type: 'integer', minimum: 1, maximum: 100 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'computer.execution',
    description: '管理不影响用户前台桌面的 Windows 专用执行桌面。',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['create', 'status', 'launch', 'diagnose', 'destroy'] },
        commandLine: { type: 'string', description: '仅 launch 需要：在专用桌面启动的完整命令行。' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'computer.browser',
    description: '通过独立 profile 和 CDP/DOM Accessibility 后端操作 Chromium 页面；不会复用用户浏览器 profile。',
    inputSchema: {
      type: 'object', required: ['action'],
      properties: {
        action: { type: 'string', enum: ['launch', 'status', 'list', 'inspect', 'click', 'setValue', 'keys', 'stop'] },
        executable: { type: 'string', description: '浏览器可执行文件路径；launch 时使用。' },
        profileDir: { type: 'string', description: '仅允许项目数据目录下的独立 profile。' },
        port: { type: 'integer', minimum: 1024, maximum: 65535 }, readyTimeoutMs: { type: 'integer', minimum: 100, maximum: 30000 }, url: { type: 'string' }, window: { type: 'string' },
        query: { type: 'object', additionalProperties: true }, value: { type: 'string' }, keys: { type: 'array', items: { type: 'object' } }
      }, additionalProperties: false
    }
  }
];

const INTERNAL_TOOL = {
  name: 'agent.internal',
  description: '可选内部干预接口：检查任务、取消任务，或在 revision 匹配时从已返回的歧义窗口候选中选择一个继续执行。',
  inputSchema: {
    type: 'object', required: ['taskId', 'op'],
    properties: {
      taskId: { type: 'string' },
      op: { type: 'string', enum: ['inspect', 'cancel', 'select-window'] },
      revision: { type: 'integer', minimum: 1 },
      window: { type: 'string', description: 'select-window 时只能选择任务已经返回的候选 ID。' }
    },
    additionalProperties: false
  }
};

const HARNESS_TOOL_NAMES = new Map([
  ['computer.state', 'computer_state'],
  ['computer.inspect', 'computer_inspect'],
  ['computer.invoke', 'computer_invoke'],
  ['shortcut.run', 'shortcut_run'],
  ['computer.verify', 'computer_verify'],
  ['computer.cancel', 'computer_cancel']
]);

function toolsForProfile(profile = '') {
  if (String(profile).toLowerCase() === 'fast-agent') return TOOLS.filter((tool) => tool.name.startsWith('agent.'));
  if (String(profile).toLowerCase() === 'intervention-agent') return [...TOOLS.filter((tool) => tool.name.startsWith('agent.')), INTERNAL_TOOL];
  if (String(profile).toLowerCase() !== 'harness') return TOOLS;
  return TOOLS
    .filter((tool) => HARNESS_TOOL_NAMES.has(tool.name))
    .map((tool) => ({ ...tool, name: HARNESS_TOOL_NAMES.get(tool.name) }));
}

function canonicalToolName(name) {
  for (const [canonical, alias] of HARNESS_TOOL_NAMES) {
    if (name === alias) return canonical;
  }
  return name;
}

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}

function toolResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {})
  };
}

module.exports = { SERVER_INFO, TOOLS, INTERNAL_TOOL, toolsForProfile, canonicalToolName, result, error, toolResult };
