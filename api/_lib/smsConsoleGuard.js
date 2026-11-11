// 문자 관리 콘솔 쓰기 스위치.
// 2026-11-11 사장님 결정("비밀번호 필요없으니까 빼버려 내가 관리하는데 무슨 비밀번호야"): 관리자 비밀번호 잠금은 두지 않는다.
// 등록·삭제를 통째로 끄려면 환경값 SMS_CONSOLE_WRITE=off.
export async function writeStatus() {
  if (process.env.SMS_CONSOLE_WRITE === 'off') return { enabled: false, reason: 'disabled' };
  return { enabled: true, reason: null };
}
