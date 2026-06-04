import type { ProjectKnowledge } from "../types.js";

export const ssutimeKnowledge: ProjectKnowledge = {
  key: "SSUTime-Prod",
  name: "슈타임",
  instructions: `
## SSU-Time (슈타임) 프로젝트 지식

### 서비스 개요
<!-- 서비스 설명을 작성하세요 -->

### 핵심 지표
<!-- DAU, MAU, 리텐션 등 핵심 지표 정의를 작성하세요 -->

### 주요 이벤트
<!-- 주요 이벤트명과 설명을 작성하세요 -->

### 비즈니스 컨텍스트
<!-- 트래픽 패턴, 시즌성, 비즈니스 규칙 등을 작성하세요 -->

### HogQL 쿼리 참고사항
<!-- 쿼리 작성 시 참고할 사항을 작성하세요 -->
`.trim(),
};
