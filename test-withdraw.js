// 필요한 라이브러리들을 CommonJS 방식(require)으로 가져옵니다.
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { sign } = require('jsonwebtoken');
const { createHash } = require('crypto');
const querystring = require('querystring');

// ==============================================================================
// ⚠️ 아래 5개의 값을 반드시 본인의 실제 정보로 수정해주세요.
// ==============================================================================
const UPBIT_ACCESS_KEY = 'JFywPkLLoqY4Ypcl0HJGqbrqXInL53zOpcxKRUgc';
const UPBIT_SECRET_KEY = 'TbWUeG3kPeOyDk8KmLJEVGYLHyX1w39B7NC4S5wp';

const WITHDRAW_ADDRESS = 'rNxp4h8apvRis6mJf9Sh8C6iRxfrDWN7AV'; // 출금 받을 주소
const WITHDRAW_TAG = '252400350'; // 데스티네이션 태그 (XRP 등)
const WITHDRAW_AMOUNT = '1'; // 테스트할 출금 수량 (문자열)
// ==============================================================================

// --- 로직 시작 ---

async function runTest() {
  console.log('--- [Upbit Withdraw Test Start] ---');

  // 해싱할 파라미터 (secondary_address와 transaction_type은 제외)
  const paramsToHash = {
    currency: 'XRP',
    net_type: 'XRP',
    amount: WITHDRAW_AMOUNT,
    address: WITHDRAW_ADDRESS,
  };

  // 1. JWT 페이로드 생성
  const payload = {
    access_key: UPBIT_ACCESS_KEY,
    nonce: uuidv4(),
  };

  // 2. 쿼리 해시 생성
  const query = querystring.encode(paramsToHash);
  const hash = createHash('sha512');
  const queryHash = hash.update(query, 'utf-8').digest('hex');

  payload.query_hash = queryHash;
  payload.query_hash_alg = 'SHA512';

  console.log('[DEBUG] Hashed Query String:', query);
  console.log('[DEBUG] Final Hash:', queryHash);

  // 3. JWT 서명
  const token = sign(payload, UPBIT_SECRET_KEY);
  console.log('[DEBUG] Generated JWT:', token);

  // 4. API 요청 본문 생성 (해싱에 사용되지 않은 파라미터 추가)
  const bodyForRequest = {
    ...paramsToHash,
    transaction_type: 'default',
    secondary_address: WITHDRAW_TAG,
  };

  console.log('[DEBUG] Request Body:', bodyForRequest);

  // 5. Axios로 API 호출
  try {
    const response = await axios.post(
      'https://api.upbit.com/v1/withdraws/coin',
      bodyForRequest,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );

    console.log('\n--- ✅ SUCCESS! ---');
    console.log('Response Data:', response.data);
  } catch (error) {
    console.error('\n--- ❌ FAILED! ---');
    if (error.response) {
      console.error('Error Status:', error.response.status);
      console.error('Error Data:', error.response.data);
    } else {
      console.error('Error Message:', error.message);
    }
  }
}

runTest();
