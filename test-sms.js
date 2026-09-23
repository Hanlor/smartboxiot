// C:\Users\vankh\smart-box-api\test-sms.js
const SMS_GATEWAY_URL = 'http://192.168.1.5:8080/message'; // IP trên App của bạn
const USERNAME = 'sms'; //[cite: 2]
const PASSWORD = 'o4uAdpeJ'; //[cite: 2]

async function testSend() {
  console.log("🚀 Đang gửi tin nhắn test tới App SMS Gateway...");
  const authHeader = 'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
  
  try {
    const res = await fetch(SMS_GATEWAY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      // SỬA ĐOẠN BODY NÀY: Bọc dữ liệu vào mảng messages hoặc khai báo đúng field phoneNumbers
   body: JSON.stringify({
  phoneNumbers: ["0769259051"], // Thay bằng SĐT nhận thật
  textMessage: {
    text: "Test Smart Box: Ma OTP cua ban la 123456"
  }
})
    });

    console.log("📩 Mã phản hồi HTTP:", res.status);
    const text = await res.text();
    console.log("💬 Phản hồi từ App:", text);
  } catch (err) {
    console.error("❌ LỖI KẾT NỐI:", err.message);
  }
}

testSend();