# Claude Code Dashboard Plugin

Claude Code の利用状況（Skill / Subagent / 外部ツール）を計測し、チームダッシュボードへ送信するプラグインです。

## Installation

```
/plugin marketplace add kosuke0227/claude-code-dashboard-plugin.git
/plugin install claude-code-dashboard
```

## Environment Variables

シェルプロファイル（`~/.zshrc`）に以下を追加してください:

```bash
# Claude Code Dashboard
export CLAUDE_DASH_INGEST_URL="https://claude-dash-ingest-6nhy6qv7mq-an.a.run.app/api/ingest"
export CLAUDE_DASH_API_KEY="<管理者から共有されたAPIキーを設定>"
```

設定後、ターミナルを再起動するか `source ~/.zshrc` を実行してください。

### Optional

`git config user.email` が会社メールでない場合のみ:

```bash
export CLAUDE_DASH_USER_EMAIL="you@company.com"
```

## Directory Convention

計測対象は `~/work/company/` 配下のリポジトリのみです。
会社リポジトリをこの配下に置いてください（移動 or 再clone）。

```bash
mkdir -p ~/work/company
cd ~/work/company
git clone git@github.com:your-org/your-repo.git
```

`~/work/company/` 以外で Claude Code を使っても計測されません（プライバシー保護）。

## How It Works

1. **PostToolUse hook**: 各ツール使用時にイベントをローカルファイルにバッファ
2. **Stop hook**: セッション終了時にトランスクリプトを解析し、Ingest API へ一括送信
3. 送信失敗時は次回セッション終了時に自動リトライ

### What is collected (metadata only)

- ツール種別・名前・回数（Skill, Subagent, external tools）
- モデル名、トークン数
- セッションID、ワークスペース名
- ユーザーメール（git config）

### What is NOT collected

- 会話内容（プロンプト / 回答テキスト）
- ファイル内容
- 個人情報

## Verification

プラグインが正常に動作しているか確認:

```bash
# バッファ / ログの確認
ls ~/.claude/claude-dash/
cat ~/.claude/claude-dash/error.log  # エラーがあれば表示

# 未送信イベントの確認
ls ~/.claude/claude-dash/failed/     # ファイルがあれば送信失敗中
```

## Uninstall

```
/plugin uninstall claude-code-dashboard
```

ローカルデータも削除する場合:

```bash
rm -rf ~/.claude/claude-dash/
```

## Troubleshooting

| 症状 | 対処 |
|---|---|
| イベントが送信されない | `CLAUDE_DASH_INGEST_URL` と `CLAUDE_DASH_API_KEY` が設定されているか確認 |
| `error.log` に `stdin timeout` | Claude Code のバージョンが古い可能性。最新版にアップデート |
| `failed/` にファイルが溜まる | ネットワーク問題。次回セッション終了時に自動リトライされます |
| 計測されていない | `~/work/company/` 配下で作業しているか確認 |

## API Key Rotation

APIキーがローテーションされた場合、新しいキーを `CLAUDE_DASH_API_KEY` に設定してください。
ターミナル再起動後、次回のセッション終了時から新キーが使われます。
