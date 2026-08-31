package ent

import (
	"context"

	"entgo.io/ent/dialect/sql"
	"github.com/99designs/gqlgen/graphql"
	"github.com/looplj/axonhub/internal/ent/request"
	"github.com/looplj/axonhub/internal/ent/requestexecution"
	"github.com/vektah/gqlparser/v2/ast"
)

var requestLogBodyFields = map[string]struct{}{
	"requestHeaders": {},
	"requestBody":    {},
	"responseBody":   {},
	"responseChunks": {},
}

var requestLogBodyColumns = map[string]struct{}{
	request.FieldRequestHeaders: {},
	request.FieldRequestBody:    {},
	request.FieldResponseBody:   {},
	request.FieldResponseChunks: {},
}

var requestListFields = fieldsWithoutRequestLogBody(request.Columns, requestLogBodyColumns)
var requestExecutionListFields = fieldsWithoutRequestLogBody(requestexecution.Columns, requestLogBodyColumns)

// RequestQueryFields 返回请求查询需要读取的列。只有 GraphQL 明确请求日志体时才读取大字段。
func RequestQueryFields(ctx context.Context) []string {
	if graphqlSelectionContainsRequestLogBody(ctx) {
		return request.Columns
	}
	return requestListFields
}

// RequestExecutionQueryFields 返回执行记录查询需要读取的列。列表场景跳过日志体和请求头。
func RequestExecutionQueryFields(ctx context.Context) []string {
	if graphqlSelectionContainsRequestLogBody(ctx) {
		return requestexecution.Columns
	}
	return requestExecutionListFields
}

// SelectRequestQueryFields 将请求查询的投影限制为当前 GraphQL 场景所需字段。
func SelectRequestQueryFields(query *RequestQuery, ctx context.Context) *RequestQuery {
	fields := RequestQueryFields(ctx)
	query.Modify(func(selector *sql.Selector) {
		selector.Select(selector.Columns(fields...)...)
	})
	return query
}

// SelectRequestExecutionQueryFields 将执行记录查询的投影限制为当前 GraphQL 场景所需字段。
func SelectRequestExecutionQueryFields(query *RequestExecutionQuery, ctx context.Context) *RequestExecutionQuery {
	fields := RequestExecutionQueryFields(ctx)
	query.Modify(func(selector *sql.Selector) {
		selector.Select(selector.Columns(fields...)...)
	})
	return query
}

func fieldsWithoutRequestLogBody(fields []string, excluded map[string]struct{}) []string {
	result := make([]string, 0, len(fields))
	for _, field := range fields {
		if _, excluded := excluded[field]; excluded {
			continue
		}
		result = append(result, field)
	}
	return result
}

func graphqlSelectionContainsRequestLogBody(ctx context.Context) bool {
	fieldContext := graphql.GetFieldContext(ctx)
	if fieldContext == nil {
		return false
	}
	return selectionContainsRequestLogBody(ctx, fieldContext.Field.Selections)
}

func selectionContainsRequestLogBody(ctx context.Context, selections ast.SelectionSet) bool {
	operationContext := graphql.GetOperationContext(ctx)
	if operationContext == nil {
		return false
	}

	for _, field := range graphql.CollectFields(operationContext, selections, nil) {
		if _, found := requestLogBodyFields[field.Name]; found {
			return true
		}
		if selectionContainsRequestLogBody(ctx, field.Selections) {
			return true
		}
	}
	return false
}
