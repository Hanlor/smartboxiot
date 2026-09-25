# 📦 Smart Box IoT System

Hệ thống tủ gửi đồ thông minh 3 ngăn — cho phép gửi/nhận hàng **không cần gặp mặt**, xác thực bằng OTP 2 lớp qua SMS.

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.x-blue.svg)](https://expressjs.com/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Demo:** https://smartboxiot-1.onrender.com

---

## 📋 Mục lục

- [Tính năng](#-tính-năng)
- [Kiến trúc](#-kiến-trúc)
- [Yêu cầu hệ thống](#-yêu-cầu-hệ-thống)
- [Cài đặt](#-cài-đặt)
- [Cấu hình](#-cấu-hình-quan-trọng)
- [Chạy Local](#-chạy-local)
- [Deploy lên Render](#-deploy-lên-render)
- [API Documentation](#-api-documentation)
- [Cấu trúc project](#-cấu-trúc-project)
- [Hardware (ESP32)](#-hardware-esp32)
- [Troubleshooting](#-troubleshooting)

---

## ✨ Tính năng

### Cho người dùng
- ✅ **Gửi hàng**: 4 bước (nhập SĐT → OTP → đặt hàng → hoàn tất)
- ✅ **Nhận hàng**: 2 bước (nhập OTP → lấy hàng)
- ✅ **Không cần app**: Chỉ SMS + Web
- ✅ **QR scan**: Quét QR tại tủ để mở web tự động
- ✅ **Gamification**: Tích điểm + vòng quay may mắn
- ✅ **Lịch sử đơn hàng**: Tra cứu và gia hạn

### Cho Admin
- ✅ **Dashboard realtime**: 3 tủ cập nhật mỗi 2s
- ✅ **Emergency unlock**: Mở khẩn cấp từng tủ hoặc tất cả
- ✅ **Hardware health**: Giám sát ESP32 online/offline
- ✅ **Lịch sử giao dịch**: Filter theo status, tủ, thời gian
- ✅ **Rate limit toggle**: Bật/tắt chống spam runtime

### Kỹ thuật
- ✅ **State machine 10 trạng thái** cho mỗi tủ
- ✅ **Bảo mật OTP 2 lớp** (Sender + Recipient)
- ✅ **Return-to-Sender**: Tự động hoàn hàng sau 24h
- ✅ **Extension**: Gia hạn thêm 24h (tối đa 1 lần)
- ✅ **Hardware monitoring**: Boot self-test + Heartbeat

---

## 🏗 Kiến trúc
[ESP32 + Sensors] → [Node.js Backend] → [In-memory + SQLite]
(Edge) (Application) (Data)

**3-tier architecture:**
- **Edge (ESP32-S3)**: Đọc sensor, điều khiển servo, giao tiếp HTTPS
- **Application (Node.js)**: State machine, business logic, OTP, SMS
- **Data (Hybrid)**: In-memory Map + SQLite + Archive file

**Tech stack:**
| Layer | Công nghệ |
|---|---|
| Backend | Node.js 18+, Express 4 |
| Database | SQLite + In-memory Map |
| Frontend | HTML5, TailwindCSS, Vanilla JS |
| SMS | sms-gate.app Cloud Gateway |
| Hardware | ESP32-S3 + Servo + NeoPixel + Reed Switch |
| Deploy | Render.com |

---

## 💻 Yêu cầu hệ thống

- **Node.js** >= 18.0.0 ([Download](https://nodejs.org/))
- **npm** >= 9.0.0 (đi kèm Node.js)
- **Git** ([Download](https://git-scm.com/))
- **Tài khoản SMS Gateway** (xem phần [Cấu hình](#-cấu-hình-quan-trọng))
- (Tùy chọn) **ESP32-S3** + linh kiện để test hardware

---

## 🚀 Cài đặt

### Bước 1: Clone repository

```bash
git clone https://github.com/<username>/<repo-name>.git
cd <repo-name>
Bước 2: Cài dependencies
npm install
Bước 3: Cấu hình môi trường
Tạo file .env ở thư mục gốc (copy từ .env.example):
cp .env.example .env
⚠️ BẮT BUỘC sửa các biến sau trong .env:
# SMS Gateway — ĐĂNG KÝ TÀI KHOẢN RIÊNG
SMS_GATEWAY_URL=https://api.sms-gate.app/3rdparty/v1/messages
SMS_GATEWAY_USER=your_username_here
SMS_GATEWAY_PASS=your_password_here

# Admin — ĐỔI MẬT KHẨU NGAY
ADMIN_SECRET_KEY=your_strong_password

# Server
PORT=3000
NODE_ENV=development

# Rate limit
RATE_LIMIT_ENABLED=false

# Return-to-sender (giờ)
RETURN_AFTER_HOURS=24
WARNING_BEFORE_HOURS=4
EXTENSION_HOURS=24
MAX_EXTENSIONS=1
Bước 4: Chạy local
bash
npm start
Mở trình duyệt: http://localhost:3000
⚙️ Cấu hình quan trọng
🔴 SMS Gateway (BẮT BUỘC)
Đây là dịch vụ gửi SMS OTP cho user. Code hiện tại dùng sms-gate.app (Cloud Gateway).

Cách 1: Đăng ký sms-gate.app (Miễn phí)
Vào https://sms-gate.app/

Đăng ký tài khoản

Lấy username và password

Điền vào .env:

SMS_GATEWAY_URL=https://api.sms-gate.app/3rdparty/v1/messages
SMS_GATEWAY_USER=<username_của_bạn>
SMS_GATEWAY_PASS=<password_của_bạn>
Cách 2: Dùng Local SMS Gateway (Android)
Nếu muốn tiết kiệm chi phí, dùng app SMS Gateway trên Android:

Cài app SMS Gateway for Android (Play Store)

Cấu hình trong app → lấy URL (VD: http://192.168.1.5:8080/message)

Điền vào .env:
SMS_GATEWAY_URL=http://192.168.1.5:8080/message
SMS_GATEWAY_USER=sms
SMS_GATEWAY_PASS=<password_trong_app>
⚠️ Lưu ý: Local gateway chỉ hoạt động khi máy và điện thoại cùng mạng LAN. Không deploy lên Render được.

🔴 Admin Secret
Đổi mật khẩu admin mặc định:

ADMIN_SECRET_KEY=<mật_khẩu_mạnh_của_bạn>
Truy cập admin console: http://localhost:3000/operator-2026.html

🟡 Các biến tùy chọn
Biến	Mặc định	Ý nghĩa
PORT	3000	Cổng server
NODE_ENV	development	Môi trường
RATE_LIMIT_ENABLED	false	Bật/tắt chống spam
RETURN_AFTER_HOURS	24	Số giờ chờ nhận hàng
WARNING_BEFORE_HOURS	4	Cảnh báo trước hạn
EXTENSION_HOURS	24	Số giờ mỗi lần gia hạn
MAX_EXTENSIONS	1	Số lần gia hạn tối đa
🏃 Chạy Local
Development
bash
npm run dev
Production
bash
npm start
Truy cập
URL	Mục đích
http://localhost:3000	Trang chủ user
http://localhost:3000/send.html	Gửi hàng
http://localhost:3000/receive.html	Nhận hàng
http://localhost:3000/manage.html	Quản lý đơn
http://localhost:3000/qr-codes.html	Sinh QR in dán tủ
http://localhost:3000/operator-2026.html	Admin console
http://localhost:3000/api/v1/lockers	API test
☁️ Deploy lên Render
Bước 1: Push code lên GitHub
bash
git add .
git commit -m "Initial commit"
git push origin main
Bước 2: Tạo Web Service trên Render
Vào https://render.com/ → New → Web Service

Connect GitHub repo

Điền:

Name: smart-box-api

Runtime: Node

Build Command: npm install

Start Command: npm start

Instance Type: Free

Bước 3: Thêm Environment Variables
Vào tab Environment → thêm các biến:

text
SMS_GATEWAY_URL       = https://api.sms-gate.app/3rdparty/v1/messages
SMS_GATEWAY_USER      = <username_của_bạn>
SMS_GATEWAY_PASS      = <password_của_bạn>
ADMIN_SECRET_KEY      = <mật_khẩu_admin>
NODE_ENV              = production
RATE_LIMIT_ENABLED    = false
RETURN_AFTER_HOURS    = 24
Bước 4: Deploy
Nhấn Create Web Service → đợi 2-3 phút → Done!

⚠️ Lưu ý Render Free tier:

Server sleep sau 15 phút không có request

Lần đầu truy cập sẽ chậm 30-60s

state.json có thể mất khi redeploy → dùng Render Disk ($1/tháng) nếu cần giữ data

📡 API Documentation
Public Endpoints
Method	Endpoint	Mô tả
GET	/api/v1/lockers	Danh sách 3 tủ + trạng thái
POST	/api/v1/shipments/create	Tạo đơn + gửi OTP người gửi
POST	/api/v1/shipments/verify-sender	Xác thực OTP người gửi
POST	/api/v1/shipments/open-deposit	Mở tủ gửi hàng
POST	/api/v1/shipments/verify-otp	Xác thực OTP người nhận
POST	/api/v1/shipments/resend-otp	Gửi lại OTP người nhận
POST	/api/v1/shipments/cancel	Hủy đơn
GET	/api/v1/shipments/mine	Tra cứu đơn theo SĐT
POST	/api/v1/shipments/extend	Gia hạn đơn
POST	/api/v1/telemetry/update	ESP32 cập nhật sensor
POST	/api/v1/telemetry/health	ESP32 heartbeat
GET	/api/v1/qr	Sinh QR code
Admin Endpoints
Method	Endpoint	Mô tả
POST	/api/v1/admin/verify	Xác thực admin key
POST	/api/v1/admin/emergency-unlock	Mở khẩn cấp
GET	/api/v1/admin/shipments	Lịch sử giao dịch
GET	/api/v1/admin/hardware-health	Sức khỏe phần cứng
GET/POST	/api/v1/admin/rate-limit	Bật/tắt rate limit
Ví dụ test API
bash
# Xem trạng thái 3 tủ
curl http://localhost:3000/api/v1/lockers

# Tạo đơn
curl -X POST http://localhost:3000/api/v1/shipments/create \
  -H "Content-Type: application/json" \
  -d '{"sender_phone":"0912345678","recipient_phone":"0769259051","locker_id":1}'

# Xác thực admin
curl -X POST http://localhost:3000/api/v1/admin/verify \
  -H "Content-Type: application/json" \
  -d '{"adminKey":"your_admin_key"}'
📁 Cấu trúc Project
text
smart-box-iot/
├── server.js                    # Entry point — khởi tạo Express + config
├── database.js                  # SQLite wrapper
├── package.json                 # Dependencies
├── .env                         # Environment variables (KHÔNG commit)
├── .env.example                 # Template env
├── .gitignore                   # Git ignore
├── state.json                   # State persistence (tự sinh)
├── archived_shipments.json      # Archive (tự sinh)
│
├── routes/
│   └── api.js                   # Định nghĩa routes
│
├── controllers/
│   └── lockerController.js      # Business logic
│
├── simulator/
│   └── esp32-sim.js             # Giả lập ESP32 để test
│
├── firmware/
│   └── smart_box_esp32.ino      # Firmware cho ESP32
│
└── public/                      # Static files
    ├── index.html               # Landing page
    ├── send.html                # Flow gửi hàng
    ├── receive.html             # Flow nhận hàng
    ├── manage.html              # Quản lý đơn
    ├── qr-codes.html            # Sinh QR codes
    ├── operator-2026.html       # Admin console
    │
    └── assets/
        ├── premium.css          # Design system
        ├── toast.js             # Toast notifications
        ├── gamification.js      # Điểm + vòng quay
        └── uth-logo.png         # Logo trường
🔧 Hardware (ESP32)
Linh kiện cần thiết
Linh kiện	Số lượng	Ghi chú
ESP32-S3 (hoặc ESP32 thường)	1	Board chính
Servo SG90	3	Khóa tủ
NeoPixel WS2812B	1	LED trạng thái (3 LED)
Reed Switch	3	Cảm biến cửa
Nút nhấn	3	Cảm biến hàng
Nguồn 5V/2A	1	Cấp cho servo
Breadboard + dây jumper	1 bộ	Kết nối
Sơ đồ chân (ESP32-S3)
Thiết bị	GPIO
Servo 1, 2, 3	1, 2, 4
NeoPixel DIN	5
Cảm biến cửa 1, 2, 3	10, 11, 12
Cảm biến hàng 1, 2, 3	13, 14, 15
Nạp firmware
Cài Arduino IDE 2.x

Cài ESP32 board support

Cài thư viện: ESP32Servo, Adafruit NeoPixel, ArduinoJson

Mở firmware/smart_box_esp32.ino

Sửa WIFI_SSID, WIFI_PASS, API_BASE trong code

Nạp code

Test không cần hardware
Dùng simulator:

bash
# Giả lập ESP32 gửi heartbeat
node simulator/esp32-sim.js --device ESP32-LAB --interval 15

# Giả lập có lỗi servo ở tủ 2
node simulator/esp32-sim.js --fail-servo 2

# Giả lập offline sau 60s (test offline detection)
node simulator/esp32-sim.js --offline-after 60
🐛 Troubleshooting
Lỗi Cannot find module 'xxx'
bash
rm -rf node_modules package-lock.json
npm install
Lỗi SMS không gửi được
Kiểm tra:

.env đã điền đúng SMS_GATEWAY_USER và SMS_GATEWAY_PASS

SĐT phải format quốc tế +84... (code tự động convert)

Test gateway bằng Postman trước

Xem log: [SMS] Failed to <phone>: ...

Lỗi SQLite SQLITE_CANTOPEN
bash
# Xóa file DB cũ
rm -f *.sqlite *.db state.json
# Khởi động lại
npm start
Render deploy fail — ReferenceError
Kiểm tra:

module.exports ở cuối files có export đúng không

Không có biến undefined trong module.exports

CORS errors
CORS đã mở origin: '*' trong server.js. Nếu vẫn lỗi:

Xóa cache browser

Test bằng curl trước: curl http://localhost:3000/api/v1/lockers

Rate limit không tắt được
Bug đã biết: Override logic có vấn đề.

Workaround: Set env RATE_LIMIT_ENABLED=false trên Render.

🧪 Testing
Test toàn bộ flow với Postman
Import postman_collection.json (nếu có)

Set baseUrl = http://localhost:3000 hoặc URL Render

Chạy collection → 15 test cases tự động

Test với ESP32 simulator
bash
# Terminal 1: Chạy server
npm start

# Terminal 2: Chạy simulator
node simulator/esp32-sim.js --device ESP32-TEST --interval 10
Mở http://localhost:3000/operator-2026.html → login → thấy device ESP32-TEST

🤝 Đóng góp
Mọi đóng góp đều được chào đón!

Fork repository

Tạo branch mới: git checkout -b feature/AmazingFeature

Commit: git commit -m 'Add AmazingFeature'

Push: git push origin feature/AmazingFeature

Tạo Pull Request

📝 License
Distributed under the MIT License. Xem LICENSE để biết thêm.

👥 Nhóm thực hiện
[Tên SV 1] — [MSSV] — Backend & DevOps

[Tên SV 2] — [MSSV] — Frontend & UI/UX

[Tên SV 3] — [MSSV] — Hardware & Firmware

Giảng viên hướng dẫn: TS. [PHAN VĂN ĐỨC]

📞 Liên hệ
Email: vankhuyen1505huynh@gamil.com

GitHub Issues: Tạo issue

Hotline (demo): 0356 297 703

🙏 Cảm ơn
Dự án được thực hiện trong khuôn khổ môn học IoT — Trường Đại học Giao thông Vận tải TP.HCM.

Made with ❤️ in Vietnam