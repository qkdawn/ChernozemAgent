import type { AgronomyKnowledgeSearchInput, AgronomyKnowledgeSearchResult } from "@chernozem/contracts";

export interface AgronomyKnowledgeSearchPort {
  search(input: AgronomyKnowledgeSearchInput): Promise<AgronomyKnowledgeSearchResult>;
}
