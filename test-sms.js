const axios = require('axios');

// Thông tin Cloud SMS Gateway từ ứng dụng trên điện thoại của bạn
const SMS_GATEWAY_URL = 'https://api.sms-gate.app/3rdparty/v1/messages';
const USERNAME = '-B-12Y';
const PASSWORD = 'xme1yle6eczm2t';

// ⚠️ THAY SỐ ĐIỆN THOẠI CỦA BẠN VÀO ĐÂY ĐỂ NHẬN TIN NHẮN TEST (Ví dụ: '0987654321')
const RECIPIENT_PHONE = '+84769259051'; 

async function testSendSMS() {
  const authHeader = 'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');

  const payload = {
    phoneNumbers: [RECIPIENT_PHONE],
    textMessage: {
      text: 'SmartBox Test: Cloud SMS gateway dang hoat dong binh thuong!',
    }
  };

  console.log(`🚀 Đang gửi tin nhắn test tới SĐT ${RECIPIENT_PHONE}...`);

  try {
    const response = await axios.post(SMS_GATEWAY_URL, payload, {
      timeout: 10000,
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
    });

    console.log('✅ GỬI TIN NHẮN THÀNH CÔNG!');
    console.log('HTTP Status:', response.status);
    console.log('Phản hồi từ Cloud Server:', JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('❌ GỬI TIN NHẮN THẤT BẠI!');
    if (error.response) {
      console.error(`HTTP Status: ${error.response.status}`);
      console.error('Chi tiết lỗi:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error('Lỗi kết nối:', error.message);
    }
  }
}

testSendSMS();