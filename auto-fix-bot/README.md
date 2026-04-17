# Auto-Fix CI Bot

Bot tự động sửa lỗi CI cho repository GitHub. Khi workflow fail, bot sẽ:

1. Parse log để extract lỗi
2. Dùng OpenAI generate fix
3. Validate fix trong Docker sandbox
4. Tạo PR với fix
5. (Tùy chọn) Auto-merge sau cooldown nếu lỗi thuộc loại "an toàn"

## Setup

### 1. Tạo GitHub App

- Vào https://github.com/organizations/YOUR_ORG/settings/apps/new
- Permissions:
  - Contents: Read & Write
  - Pull requests: Read & Write
  - Actions: Read
  - Metadata: Read
- Subscribe to events: `Workflow run`, `Check run`, `Pull request`
- Webhook URL: `https://your-domain.com/webhook`
- Lưu App ID, generate Private Key, set Webhook Secret

### 2. Install lên org của bạn

### 3. Cấu hình

```bash
cp .env.example .env
# Điền các giá trị thực tế
```

### 4. Run

```bash
docker compose up --build
```

## Limitations hiện tại của MVP này

- **Chưa có auto-merge logic** — mới chỉ tạo PR. Cần thêm webhook handler cho `check_run.completed` để watch PR và merge khi đủ điều kiện.
- **Log parser cơ bản** — chỉ handle Node, Python, Go với pattern phổ biến. Real-world cần mở rộng cho từng test framework.
- **Không có context về codebase rộng hơn** — LLM chỉ thấy file lỗi. Với lỗi liên quan nhiều module, fix có thể không đủ context. Nâng cấp: dùng tree-sitter hoặc embedding để pull related files.
- **Không có loop retry với feedback** — nếu validation fail, bot bỏ. Có thể implement: gửi error mới về cho LLM, thử lại tối đa N lần.
- **Cost control** — mỗi job có thể tốn $0.05–$0.50 OpenAI. Cần thêm tracking và budget limit per repo/org.

## Roadmap

- [ ] Auto-merge handler với cooldown
- [ ] Retry loop với feedback từ validation
- [ ] Cost tracking per installation
- [ ] Notification (Slack) khi bot bỏ cuộc
- [ ] Dashboard xem history các fix
- [ ] Support thêm languages (Rust, Java, Ruby)
- [ ] Embedding-based context retrieval cho fix phức tạp
