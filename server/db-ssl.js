import fs from 'node:fs';
import path from 'node:path';

// 数据库 TLS 配置(共享,避免多处重复并保持一致的安全语义)。
//   DATABASE_SSL=true            严格校验证书(推荐;公开 CA,或配合 DATABASE_CA 使用)
//   DATABASE_SSL=no-verify       仅加密、不校验证书(不推荐;仅自签名且无 CA 时显式使用)
//   DATABASE_CA=/path/to/ca.pem  自定义 CA 证书路径(可选,配合 DATABASE_SSL=true)
export function resolveDbSsl() {
  const mode = String(process.env.DATABASE_SSL || '').toLowerCase();
  if (mode === 'true' || mode === 'require' || mode === 'verify-full') {
    const ssl = { rejectUnauthorized: true };
    if (process.env.DATABASE_CA) ssl.ca = fs.readFileSync(path.resolve(process.env.DATABASE_CA));
    return ssl;
  }
  if (mode === 'no-verify') return { rejectUnauthorized: false };
  return undefined;
}
