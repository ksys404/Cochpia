# 手机局域网开发访问

开发服务器固定使用以下端口：

- Web: `5173`
- API: `8787`

Vite 和 API 已绑定到 `0.0.0.0`，手机应访问电脑当前 WLAN IPv4 地址，例如：

`http://10.118.135.248:5173/`

如果访问不稳定，先在 PowerShell 中确认当前地址：

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -match 'WLAN|Wi-Fi' -and $_.IPAddress -notmatch '^(127|169\\.254)' }
```

端口放行需要管理员权限。仅允许当前局域网访问：

```powershell
New-NetFirewallRule -DisplayName 'Cochpia Dev Web 5173' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5173 -Profile Any -RemoteAddress LocalSubnet
New-NetFirewallRule -DisplayName 'Cochpia Dev API 8787' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8787 -Profile Any -RemoteAddress LocalSubnet
```

手机和电脑必须连接同一个 WLAN，且不能使用会隔离设备的访客网络、VPN 或代理。电脑 IP 变化后，需要使用新的地址访问；项目本身不应把局域网 IP 写入前端代码。
