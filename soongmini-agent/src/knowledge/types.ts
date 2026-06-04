export interface ProjectKnowledge {
  /** 프로젝트/레포 식별자 (PostHogProject.name 또는 repo명과 일치) */
  key: string;
  /** 표시명 */
  name: string;
  /** 시스템 프롬프트에 주입할 도메인 지식 */
  instructions: string;
}
