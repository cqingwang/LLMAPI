package ent

import (
	"testing"

	"github.com/looplj/axonhub/internal/ent/request"
	"github.com/looplj/axonhub/internal/ent/requestexecution"
)

func TestRequestListFieldsExcludeRequestLogBody(t *testing.T) {
	assertFieldsExclude(t, requestListFields, requestLogBodyColumns)
	assertFieldsExclude(t, requestExecutionListFields, requestLogBodyColumns)
}

func TestRequestLogBodyFieldsAreAvailableForDetails(t *testing.T) {
	assertFieldsInclude(t, request.Columns, requestLogBodyColumns)
	assertFieldsInclude(t, requestexecution.Columns, requestLogBodyColumns)
}

func assertFieldsExclude(t *testing.T, fields []string, excluded map[string]struct{}) {
	t.Helper()
	for _, field := range fields {
		if _, found := excluded[field]; found {
			t.Fatalf("轻量查询不应包含日志体字段 %q", field)
		}
	}
}

func assertFieldsInclude(t *testing.T, fields []string, expected map[string]struct{}) {
	t.Helper()
	for field := range expected {
		found := false
		for _, actual := range fields {
			if actual == field {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("详情查询字段缺少 %q", field)
		}
	}
}
