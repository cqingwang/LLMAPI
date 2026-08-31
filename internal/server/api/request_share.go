package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"go.uber.org/fx"

	"github.com/looplj/axonhub/internal/authz"
	"github.com/looplj/axonhub/internal/contexts"
	"github.com/looplj/axonhub/internal/ent"
	"github.com/looplj/axonhub/internal/ent/requestexecution"
	"github.com/looplj/axonhub/internal/ent/usagelog"
	"github.com/looplj/axonhub/internal/objects"
	"github.com/looplj/axonhub/internal/server/biz"
)

type RequestShareHandlersParams struct {
	fx.In

	RequestService *biz.RequestService
}

type RequestShareHandlers struct {
	RequestService *biz.RequestService
}

func NewRequestShareHandlers(params RequestShareHandlersParams) *RequestShareHandlers {
	return &RequestShareHandlers{RequestService: params.RequestService}
}

type SharedRequestLog struct {
	Request    *ent.Request            `json:"request"`
	Executions []*ent.RequestExecution `json:"executions"`
	UsageLogs  []*ent.UsageLog         `json:"usageLogs"`
}

// ShareRequest 根据 sessionid 返回可直接交给智能体分析的请求日志 JSON。
// 不带 sessionid 时由路由层继续提供 SPA 页面，不会进入此处理逻辑。
func (h *RequestShareHandlers) ShareRequest(c *gin.Context) {
	ctx := c.Request.Context()
	requestID, err := parseSharedRequestID(c.Param("request_id"))
	if err != nil {
		JSONError(c, http.StatusBadRequest, err)
		return
	}

	requestEntity, err := authz.RunWithSystemBypass(ctx, "request-share-project-lookup", func(bypassCtx context.Context) (*ent.Request, error) {
		return ent.FromContext(bypassCtx).Request.Get(bypassCtx, requestID)
	})
	if err != nil {
		writeSharedRequestError(c, err)
		return
	}

	ctx = contexts.WithProjectID(ctx, requestEntity.ProjectID)
	requestEntity, err = ent.FromContext(ctx).Request.Get(ctx, requestID)
	if err != nil {
		writeSharedRequestError(c, err)
		return
	}

	requestEntity.RequestBody, err = h.RequestService.LoadRequestBody(ctx, requestEntity)
	if err != nil {
		JSONError(c, http.StatusInternalServerError, errors.New("Failed to load request body"))
		return
	}
	requestEntity.ResponseBody, err = h.RequestService.LoadResponseBody(ctx, requestEntity)
	if err != nil {
		JSONError(c, http.StatusInternalServerError, errors.New("Failed to load response body"))
		return
	}
	requestEntity.ResponseChunks, err = h.RequestService.LoadResponseChunks(ctx, requestEntity)
	if err != nil {
		JSONError(c, http.StatusInternalServerError, errors.New("Failed to load response chunks"))
		return
	}

	executions, err := ent.FromContext(ctx).RequestExecution.Query().
		Where(requestexecution.RequestIDEQ(requestID)).
		Order(ent.Desc(requestexecution.FieldCreatedAt)).
		All(ctx)
	if err != nil {
		JSONError(c, http.StatusInternalServerError, errors.New("Failed to load request executions"))
		return
	}
	for _, execution := range executions {
		execution.RequestBody, err = h.RequestService.LoadRequestExecutionRequestBody(ctx, execution)
		if err != nil {
			JSONError(c, http.StatusInternalServerError, errors.New("Failed to load execution request body"))
			return
		}
		execution.ResponseBody, err = h.RequestService.LoadRequestExecutionResponseBody(ctx, execution)
		if err != nil {
			JSONError(c, http.StatusInternalServerError, errors.New("Failed to load execution response body"))
			return
		}
		execution.ResponseChunks, err = h.RequestService.LoadRequestExecutionResponseChunks(ctx, execution)
		if err != nil {
			JSONError(c, http.StatusInternalServerError, errors.New("Failed to load execution response chunks"))
			return
		}
	}

	usageLogs, err := ent.FromContext(ctx).UsageLog.Query().
		Where(usagelog.RequestIDEQ(requestID)).
		Order(ent.Desc(usagelog.FieldID)).
		All(ctx)
	if err != nil {
		JSONError(c, http.StatusInternalServerError, errors.New("Failed to load request usage logs"))
		return
	}

	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusOK, SharedRequestLog{
		Request:    requestEntity,
		Executions: executions,
		UsageLogs:  usageLogs,
	})
}

func parseSharedRequestID(value string) (int, error) {
	value = strings.TrimSpace(value)
	guid, err := objects.ParseGUID(value)
	if err != nil || guid.Type != ent.TypeRequest || guid.ID <= 0 {
		return 0, fmt.Errorf("invalid request ID")
	}
	return guid.ID, nil
}

func writeSharedRequestError(c *gin.Context, err error) {
	if ent.IsNotFound(err) {
		JSONError(c, http.StatusNotFound, errors.New("Request not found"))
		return
	}
	JSONError(c, http.StatusInternalServerError, errors.New("Failed to load request"))
}
