import http from 'http';
import https from 'https';

const PORT = process.env.PORT || 3000;

// 1人専用：直前にアクセスしたベースURL（ドメイン）をメモリに1つだけ記憶
let lastBaseUrl = "";

http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathPart = urlObj.pathname.slice(1);

  let targetUrl = "";

  // ----------------------------------------------------
  // 1. パスなし（トップページ）の処理
  // ----------------------------------------------------
  if (!pathPart && !lastBaseUrl) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8"
    });

    res.end(
      "最初にURLをBase64にして、ドメインの後ろにくっつけてアクセスしてください。"
    );

    return;
  }

  // ----------------------------------------------------
  // 2. 通信の振り分け
  // ----------------------------------------------------

  // パスがBase64のURL
  if (pathPart.startsWith("aHR0c")) {
    try {
      let b64String = pathPart;

      while (b64String.length % 4 !== 0) {
        b64String += "=";
      }

      targetUrl = Buffer.from(b64String, "base64").toString("utf-8");

      const parsedTarget = new URL(targetUrl);

      lastBaseUrl = parsedTarget.origin;

      console.log(`🆕 Base64からドメインを記憶: ${lastBaseUrl}`);
    } catch {
      res.writeHead(400);
      res.end("Base64のデコードに失敗しました");
      return;
    }
  }

  // パスが普通の文字列
  else if (lastBaseUrl) {
    targetUrl = `${lastBaseUrl}/${pathPart}${urlObj.search}`;

    console.log(` └ 記憶したベースから転送: ${targetUrl}`);
  }

  else {
    res.writeHead(400);
    res.end("最初にURLを設定してください。");
    return;
  }

  // ----------------------------------------------------
  // 3. ターゲットのサイトへ通信
  // ----------------------------------------------------
  try {
    const client = targetUrl.startsWith("https") ? https : http;

    const headers = { ...req.headers };

    delete headers.host;

    // ------------------------------------------------
    // 実験3：
    // リクエスト内容をログに記録するだけ
    // 通信内容自体は変更しない
    // ------------------------------------------------

    console.log("");
    console.log("========================================");
    console.log("🔍 EXPERIMENT 3");
    console.log("========================================");
    console.log("Target URL:", targetUrl);
    console.log("");
    console.log("Forwarded request headers:");
    console.log(JSON.stringify(headers, null, 2));
    console.log("========================================");

    // HTMLを加工できるよう、圧縮されていない状態で受け取る
    headers["accept-encoding"] = "identity";

    client.get(targetUrl, { headers }, (targetRes) => {

      // ------------------------------------------------
      // 4. ターゲットからのレスポンスをログに記録
      // ------------------------------------------------

      console.log("");
      console.log("========================================");
      console.log("📥 TARGET RESPONSE");
      console.log("========================================");
      console.log("Status:", targetRes.statusCode);
      console.log("");
      console.log("Response headers:");
      console.log(JSON.stringify(targetRes.headers, null, 2));
      console.log("========================================");

      // ------------------------------------------------
      // 5. レスポンスヘッダーを加工
      // ------------------------------------------------

      const responseHeaders = { ...targetRes.headers };

      // iframe禁止系ヘッダーを削除
      delete responseHeaders["x-frame-options"];
      delete responseHeaders["content-security-policy"];

      // HTMLを書き換える可能性があるため削除
      delete responseHeaders["content-length"];
      delete responseHeaders["content-encoding"];

      const contentType = responseHeaders["content-type"] || "";

      // ------------------------------------------------
      // 6. HTML以外は今まで通りそのまま転送
      // ------------------------------------------------

      if (!contentType.toLowerCase().includes("text/html")) {
        res.writeHead(targetRes.statusCode, responseHeaders);

        targetRes.pipe(res);

        return;
      }

      // ------------------------------------------------
      // 7. HTMLだけ加工
      // ------------------------------------------------

      const chunks = [];

      targetRes.on("data", (chunk) => {
        chunks.push(chunk);
      });

      targetRes.on("end", () => {
        try {
          let html = Buffer.concat(chunks).toString("utf-8");

          // --------------------------------------------
          // iframe禁止METAを削除
          // 大文字・小文字は区別しない
          // --------------------------------------------

          html = html.replace(
            /<meta\b[^>]*(?:http-equiv\s*=\s*["']?\s*(?:content-security-policy|x-frame-options)\s*["']?)[^>]*>/gi,
            ""
          );

          // --------------------------------------------
          // 既存の <base> がなければ追加
          // --------------------------------------------

          const hasBaseTag = /<base\b[^>]*>/i.test(html);

          if (!hasBaseTag) {
            const forwardedProto =
              req.headers["x-forwarded-proto"] || "https";

            const proxyOrigin =
              `${forwardedProto}://${req.headers.host}/`;

            html = html.replace(
              /<head\b[^>]*>/i,
              (match) => {
                return (
                  match +
                  `\n<base href="${proxyOrigin}">\n`
                );
              }
            );
          }

          // --------------------------------------------
          // iframe表示用のレスポンスヘッダーを追加
          // --------------------------------------------

          responseHeaders["x-frame-options"] = "ALLOWALL";
          responseHeaders["content-security-policy"] =
            "frame-ancestors *";

          responseHeaders["content-type"] =
            "text/html; charset=utf-8";

          const body = Buffer.from(html, "utf-8");

          res.writeHead(targetRes.statusCode, responseHeaders);

          res.end(body);

        } catch (err) {
          console.error("HTML加工エラー:", err);

          res.writeHead(500, {
            "Content-Type": "text/plain; charset=utf-8"
          });

          res.end("HTMLの加工に失敗しました。");
        }
      });

      targetRes.on("error", () => {
        console.error("❌ Target response error");

        if (!res.headersSent) {
          res.writeHead(500);
        }

        res.end("ターゲットとの通信に失敗しました。");
      });
    }).on("error", (err) => {
      console.error("❌ Target request error:", err);

      if (!res.headersSent) {
        res.writeHead(500);
      }

      res.end("ターゲットとの通信に失敗しました。");
    });

  } catch (err) {
    console.error("❌ Proxy error:", err);

    res.writeHead(500);
    res.end("エラーが発生しました。");
  }

}).listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
