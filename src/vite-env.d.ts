/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 분리 배포 시 백엔드 주소 (예: https://puzzle-api.onrender.com). 비우면 같은 origin을 쓴다. */
  readonly VITE_API_URL?: string
}
