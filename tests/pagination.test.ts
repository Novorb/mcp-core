import { describe, it, expect } from '@jest/globals';
import {
  normalizePagination,
  createPaginationMetadata,
  pageToOffset,
  paginateArray,
} from '../src/pagination.js';

describe('pagination utilities', () => {
  describe('normalizePagination', () => {
    it('should use defaults when no params', () => {
      const result = normalizePagination();
      expect(result).toEqual({ page: 1, per_page: 20 });
    });

    it('should use provided values', () => {
      const result = normalizePagination({ page: 3, per_page: 50 });
      expect(result).toEqual({ page: 3, per_page: 50 });
    });

    it('should enforce minimum page of 1', () => {
      const result = normalizePagination({ page: 0 });
      expect(result.page).toBe(1);

      const result2 = normalizePagination({ page: -5 });
      expect(result2.page).toBe(1);
    });

    it('should enforce minimum per_page of 1', () => {
      const result = normalizePagination({ per_page: 0 });
      expect(result.per_page).toBe(1);
    });

    it('should enforce maximum per_page', () => {
      const result = normalizePagination({ per_page: 500 });
      expect(result.per_page).toBe(100);
    });

    it('should accept custom maxPerPage', () => {
      const result = normalizePagination({ per_page: 500 }, 200);
      expect(result.per_page).toBe(200);
    });

    it('should accept custom defaultPerPage', () => {
      const result = normalizePagination(undefined, 100, 50);
      expect(result.per_page).toBe(50);
    });
  });

  describe('createPaginationMetadata', () => {
    it('should calculate total pages correctly', () => {
      const meta = createPaginationMetadata(100, { page: 1, per_page: 20 });
      expect(meta).toEqual({
        totalCount: 100,
        page: 1,
        perPage: 20,
        totalPages: 5,
      });
    });

    it('should round up total pages', () => {
      const meta = createPaginationMetadata(101, { page: 1, per_page: 20 });
      expect(meta.totalPages).toBe(6);
    });

    it('should handle zero total count', () => {
      const meta = createPaginationMetadata(0, { page: 1, per_page: 20 });
      expect(meta.totalPages).toBe(0);
    });

    it('should handle single item', () => {
      const meta = createPaginationMetadata(1, { page: 1, per_page: 20 });
      expect(meta.totalPages).toBe(1);
    });
  });

  describe('pageToOffset', () => {
    it('should convert page 1 to offset 0', () => {
      expect(pageToOffset(1, 20)).toBe(0);
    });

    it('should convert page 2 to correct offset', () => {
      expect(pageToOffset(2, 20)).toBe(20);
    });

    it('should convert page 5 to correct offset', () => {
      expect(pageToOffset(5, 10)).toBe(40);
    });

    it('should handle page 0 as page 1', () => {
      expect(pageToOffset(0, 20)).toBe(0);
    });
  });

  describe('paginateArray', () => {
    const items = Array.from({ length: 55 }, (_, i) => i);

    it('should return first page', () => {
      const result = paginateArray(items, { page: 1, per_page: 20 });
      expect(result.data).toEqual(Array.from({ length: 20 }, (_, i) => i));
      expect(result.metadata.totalCount).toBe(55);
      expect(result.metadata.totalPages).toBe(3);
      expect(result.metadata.page).toBe(1);
    });

    it('should return second page', () => {
      const result = paginateArray(items, { page: 2, per_page: 20 });
      expect(result.data).toEqual(Array.from({ length: 20 }, (_, i) => i + 20));
    });

    it('should return partial last page', () => {
      const result = paginateArray(items, { page: 3, per_page: 20 });
      expect(result.data).toEqual(Array.from({ length: 15 }, (_, i) => i + 40));
    });

    it('should return empty for beyond last page', () => {
      const result = paginateArray(items, { page: 10, per_page: 20 });
      expect(result.data).toEqual([]);
      expect(result.metadata.totalCount).toBe(55);
    });

    it('should handle empty array', () => {
      const result = paginateArray([], { page: 1, per_page: 20 });
      expect(result.data).toEqual([]);
      expect(result.metadata.totalCount).toBe(0);
      expect(result.metadata.totalPages).toBe(0);
    });
  });
});
