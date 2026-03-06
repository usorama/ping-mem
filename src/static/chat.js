/**
 * ping-mem Chat Panel — vanilla JS
 *
 * Floating chat button, expandable panel, streaming fetch from /ui/api/chat.
 * No dependencies beyond what's already on the page.
 */

(function () {
  "use strict";

  // ── State ──────────────────────────────────────────────────────────────
  var isOpen = false;
  var isLoading = false;

  // ── Create DOM ─────────────────────────────────────────────────────────

  // Floating button
  var btn = document.createElement("button");
  btn.id = "chat-toggle";
  btn.setAttribute("aria-label", "Open chat");
  btn.title = "Ask ping-mem";
  btn.textContent = "\u2709";
  btn.style.cssText =
    "position:fixed;bottom:24px;right:24px;width:48px;height:48px;" +
    "border-radius:50%;background:var(--accent);color:#fff;border:none;" +
    "font-size:20px;cursor:pointer;z-index:1000;box-shadow:0 2px 8px rgba(0,0,0,0.2);" +
    "display:flex;align-items:center;justify-content:center;transition:transform 0.2s";
  document.body.appendChild(btn);

  // Chat panel
  var panel = document.createElement("div");
  panel.id = "chat-panel";
  panel.style.cssText =
    "position:fixed;bottom:84px;right:24px;width:380px;max-height:500px;" +
    "background:var(--bg-primary);border:1px solid var(--border);border-radius:12px;" +
    "box-shadow:0 4px 24px rgba(0,0,0,0.15);z-index:1000;display:none;" +
    "flex-direction:column;overflow:hidden;font-size:14px";

  panel.innerHTML =
    '<div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">' +
    '  <span style="font-weight:600">Ask ping-mem</span>' +
    '  <span id="chat-model" style="font-size:11px;color:var(--text-secondary)"></span>' +
    "</div>" +
    '<div id="chat-messages" style="flex:1;overflow-y:auto;padding:12px 16px;min-height:200px;max-height:360px"></div>' +
    '<div style="padding:8px 12px;border-top:1px solid var(--border);display:flex;gap:8px">' +
    '  <input id="chat-input" type="text" placeholder="Ask about your codebase..." ' +
    '    style="flex:1;padding:8px 12px;border:1px solid var(--border);border-radius:6px;' +
    '    background:var(--bg-secondary);color:var(--text-primary);font-size:13px;outline:none">' +
    '  <button id="chat-send" style="padding:8px 16px;border-radius:6px;background:var(--accent);' +
    '    color:#fff;border:none;cursor:pointer;font-size:13px">Send</button>' +
    "</div>";

  document.body.appendChild(panel);

  var messagesDiv = document.getElementById("chat-messages");
  var input = document.getElementById("chat-input");
  var sendBtn = document.getElementById("chat-send");
  var modelBadge = document.getElementById("chat-model");

  // ── Helpers ────────────────────────────────────────────────────────────

  function addMessage(role, text) {
    var div = document.createElement("div");
    div.style.cssText =
      "margin-bottom:12px;padding:8px 12px;border-radius:8px;max-width:90%;word-wrap:break-word;" +
      "white-space:pre-wrap;font-size:13px;line-height:1.5;" +
      (role === "user"
        ? "background:var(--accent);color:#fff;margin-left:auto;text-align:right"
        : "background:var(--bg-secondary);color:var(--text-primary)");
    div.textContent = text;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    return div;
  }

  function escapeText(str) {
    var d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  // ── Send message ───────────────────────────────────────────────────────

  function sendMessage() {
    var text = input.value.trim();
    if (!text || isLoading) return;

    addMessage("user", text);
    input.value = "";
    isLoading = true;
    sendBtn.disabled = true;
    sendBtn.textContent = "...";

    var assistantDiv = addMessage("assistant", "");
    var fullContent = "";

    fetch("/ui/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    })
      .then(function (response) {
        if (!response.ok) throw new Error("Chat request failed");
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = "";

        function read() {
          return reader.read().then(function (result) {
            if (result.done) {
              finish();
              return;
            }

            buffer += decoder.decode(result.value, { stream: true });
            var lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (var i = 0; i < lines.length; i++) {
              var line = lines[i].trim();
              if (!line.startsWith("data: ")) continue;

              try {
                var chunk = JSON.parse(line.slice(6));
                fullContent += chunk.content;
                assistantDiv.textContent = fullContent;
                messagesDiv.scrollTop = messagesDiv.scrollHeight;

                if (chunk.model && chunk.model !== "none") {
                  modelBadge.textContent = chunk.provider + ":" + chunk.model;
                }

                if (chunk.done) {
                  finish();
                  return;
                }
              } catch (e) {
                console.warn("[Chat] Malformed SSE chunk:", line.slice(0, 100), e);
              }
            }

            return read();
          });
        }

        return read();
      })
      .catch(function (err) {
        assistantDiv.textContent =
          "Error: " + (err.message || "Failed to connect");
        finish();
      });

    function finish() {
      isLoading = false;
      sendBtn.disabled = false;
      sendBtn.textContent = "Send";
    }
  }

  // ── Event listeners ────────────────────────────────────────────────────

  btn.addEventListener("click", function () {
    isOpen = !isOpen;
    panel.style.display = isOpen ? "flex" : "none";
    btn.textContent = isOpen ? "\u2715" : "\u2709";
    if (isOpen) input.focus();
  });

  sendBtn.addEventListener("click", sendMessage);

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Close on Escape
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && isOpen) {
      isOpen = false;
      panel.style.display = "none";
      btn.textContent = "\u2709";
    }
  });
})();
