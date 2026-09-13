import http from 'http';
import https from 'https';

const PORT = process.env.PORT || 3000;

http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathPart = urlObj.pathname.slice(1);

  // 1. トップページ（入力フォーム）
  if (!pathPart) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <style>body { font-family: sans-serif; text-align: center; padding-top: 50px; }</style>
      <h2>ハイブリッド・プロキシ (WS直通版)</h2>
      <form action="/set-target" method="POST">
        <input type="text" name="url" placeholder="https://example.com" required autofocus style="width:300px; padding:5px;">
        <button type="submit" style="padding:5px 10px;">Go</button>
      </form>
    `);
    return;
  }

  // 2. フォーム送信（Base64URLへ変換）
  if (req.method === "POST" && urlObj.pathname === "/set-target") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const params = new URLSearchParams(body);
      let inputUrl = params.get("url") || "";
      if (!inputUrl.startsWith("http")) inputUrl = "https://" + inputUrl;
      
      const b64 = Buffer.from(inputUrl).toString("base64").replace(/=/g, "");
      res.writeHead(302, { "Location": "/" + b64 });
      res.end();
    });
    return;
  }

  // 3. 通信の解析（Base64から元のURLを復元）
  let targetUrl = "";
  try {
    let b64String = pathPart.split('/')[0]; // スラッシュ以降のパスを除外してデコード
    while (b64String.length % 4 !== 0) { b64String += "="; }
    const originUrl = Buffer.from(b64String, "base64").toString("utf-8");
    
    // 画像や追加リクエスト時のサブパス（/images/abc.pngなど）を結合
    const subPath = urlObj.pathname.replace(`/${pathPart.split('/')[0]}`, '');
    targetUrl = `${originUrl}${subPath}${urlObj.search}`;
  } catch {
    res.writeHead(400); res.end("URLの解析に失敗しました。");
    return;
  }

  // 4. 身代わり通信 ＋ セキュリティ解除 ＋ 魔法のスクリプト挿入
  try {
    const parsedTarget = new URL(targetUrl);
    const client = targetUrl.startsWith("https") ? https : http;
    const headers = { ...req.headers };
    headers.host = parsedTarget.host; 
    delete headers.referer;

    client.get(targetUrl, { headers }, (targetRes) => {
      const cleanHeaders = { ...targetRes.headers };
      
      // CSPやiframe制限、HSTSの解除
      delete cleanHeaders['content-security-policy'];
      delete cleanHeaders['content-security-policy-report-only'];
      delete cleanHeaders['strict-transport-security'];
      cleanHeaders["X-Frame-Options"] = "ALLOWALL";
      cleanHeaders["Access-Control-Allow-Origin"] = "*";

      const contentType = cleanHeaders['content-type'] || '';
      
      // HTMLの場合だけ、WebSocketを本家へ直通させる仕組みを仕込む
      if (contentType.includes('text/html')) {
        let chunks = [];
        targetRes.on('data', chunk => chunks.push(chunk));
        targetRes.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf-8');
          
          // 本家のドメイン（WebSocket送信用）
          const wsTargetOrigin = parsedTarget.origin.replace(/^http/, 'ws');

          // 【核心】ブラウザのWebSocket関数を乗っ取り、接続先を強制的に本家サイトに向けるスクリプト
          const injectScript = `
            <script>
              (function() {
                const OriginalWebSocket = window.WebSocket;
                window.WebSocket = function(url, protocols) {
                  let targetUrl = url;
                  // もし相対パス（/socket など）で接続しようとしたら、本家のドメインを付与する
                  if (url.startsWith('/') || (!url.startsWith('ws://') && !url.startsWith('wss://'))) {
                    const separator = url.startsWith('/') ? '' : '/';
                    targetUrl = "${wsTargetOrigin}" + separator + url;
                  }
                  console.log("[Proxy] WebSocket接続を本家へ直通させました:", targetUrl);
                  return protocols ? new OriginalWebSocket(targetUrl, protocols) : new OriginalWebSocket(targetUrl);
                };
                window.WebSocket.prototype = OriginalWebSocket.prototype;
              })();
            </script>
          `;

          // baseタグと乗っ取りスクリプトを<head>に挿入
          const baseTag = `<base href="${parsedTarget.origin}/">`;
          html = html.replace('<head>', `<head>${baseTag}${injectScript}`);

          cleanHeaders['content-length'] = Buffer.byteLength(html);
          res.writeHead(targetRes.statusCode, cleanHeaders);
          res.end(html);
        });
      } else {
        // 画像、CSS、JSなどはRenderが身代わりに取得してそのままブラウザへ流す
        res.writeHead(targetRes.statusCode, cleanHeaders);
        targetRes.pipe(res);
      }
    }).on("error", () => {
      res.writeHead(500); res.end("通信相手のサイトに接続できませんでした。");
    });
  } catch (err) {
    res.writeHead(500); res.end("エラーが発生しました。");
  }
}).listen(PORT);
