# Thinkbuddy-Proxy

## Introduction

Thinkbuddy API Proxy for Open-WebUI

## Features

- 兼容 OpenAI API
- 使用 KV 进行 Token 缓存，避免频繁获取触发 Firebase API 限制

## Installation

1. CloudFlare 新建 KV 命名空间

```bash
npx wrangler kv:namespace create "KV_NAME" # 获取id
npx wrangler kv:namespace list # 或直接查看已有KV命名空间id
```

2. 填入`wrangler.toml`的`KV_NAMESPACE_ID`处

## Usage

- [Deno Deploy](https://deno.dev)使用`main.ts`部署
- [Cloudflare Workers](https://workers.cloudflare.com)使用`worker.js`部署

## Maintainers

- [Senkita](https://github.com/Senkita)

## License

[GNU AFFERO GENERAL PUBLIC LICENSE](LICENSE) &copy; [Senkita](https://github.com/Senkita)
