export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      agent_events: {
        Row: {
          created_at: string
          id: number
          kind: Database["public"]["Enums"]["agent_event_kind"]
          payload: Json
          run_attempt_id: string
        }
        Insert: {
          created_at?: string
          id?: number
          kind: Database["public"]["Enums"]["agent_event_kind"]
          payload: Json
          run_attempt_id: string
        }
        Update: {
          created_at?: string
          id?: number
          kind?: Database["public"]["Enums"]["agent_event_kind"]
          payload?: Json
          run_attempt_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_events_run_attempt_id_fkey"
            columns: ["run_attempt_id"]
            isOneToOne: false
            referencedRelation: "run_attempts"
            referencedColumns: ["id"]
          },
        ]
      }
      hook_runs: {
        Row: {
          created_at: string
          duration_ms: number
          exit_code: number
          hook: Database["public"]["Enums"]["hook_name"]
          id: number
          run_attempt_id: string | null
          stderr_tail: string | null
        }
        Insert: {
          created_at?: string
          duration_ms: number
          exit_code: number
          hook: Database["public"]["Enums"]["hook_name"]
          id?: number
          run_attempt_id?: string | null
          stderr_tail?: string | null
        }
        Update: {
          created_at?: string
          duration_ms?: number
          exit_code?: number
          hook?: Database["public"]["Enums"]["hook_name"]
          id?: number
          run_attempt_id?: string | null
          stderr_tail?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hook_runs_run_attempt_id_fkey"
            columns: ["run_attempt_id"]
            isOneToOne: false
            referencedRelation: "run_attempts"
            referencedColumns: ["id"]
          },
        ]
      }
      issues: {
        Row: {
          blockers: string[]
          branch: string | null
          description: string | null
          id: string
          identifier: string
          labels: string[]
          last_seen_at: string
          priority: number
          raw: Json
          state: string
          title: string
        }
        Insert: {
          blockers?: string[]
          branch?: string | null
          description?: string | null
          id: string
          identifier: string
          labels?: string[]
          last_seen_at?: string
          priority?: number
          raw: Json
          state: string
          title: string
        }
        Update: {
          blockers?: string[]
          branch?: string | null
          description?: string | null
          id?: string
          identifier?: string
          labels?: string[]
          last_seen_at?: string
          priority?: number
          raw?: Json
          state?: string
          title?: string
        }
        Relationships: []
      }
      live_sessions: {
        Row: {
          input_tokens: number
          last_event_at: string
          output_tokens: number
          run_attempt_id: string
          session_id: string
          started_at: string
          thread_id: string
          total_tokens: number
          turn_id: string
        }
        Insert: {
          input_tokens?: number
          last_event_at?: string
          output_tokens?: number
          run_attempt_id: string
          session_id: string
          started_at?: string
          thread_id: string
          total_tokens?: number
          turn_id: string
        }
        Update: {
          input_tokens?: number
          last_event_at?: string
          output_tokens?: number
          run_attempt_id?: string
          session_id?: string
          started_at?: string
          thread_id?: string
          total_tokens?: number
          turn_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_sessions_run_attempt_id_fkey"
            columns: ["run_attempt_id"]
            isOneToOne: true
            referencedRelation: "run_attempts"
            referencedColumns: ["id"]
          },
        ]
      }
      retry_queue: {
        Row: {
          attempt_number: number
          created_at: string
          due_at: string
          error_class: string | null
          error_message: string | null
          issue_id: string
        }
        Insert: {
          attempt_number: number
          created_at?: string
          due_at: string
          error_class?: string | null
          error_message?: string | null
          issue_id: string
        }
        Update: {
          attempt_number?: number
          created_at?: string
          due_at?: string
          error_class?: string | null
          error_message?: string | null
          issue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "retry_queue_issue_id_fkey"
            columns: ["issue_id"]
            isOneToOne: true
            referencedRelation: "issues"
            referencedColumns: ["id"]
          },
        ]
      }
      run_attempts: {
        Row: {
          attempt_number: number
          created_at: string
          ended_at: string | null
          error_class: string | null
          error_message: string | null
          id: string
          issue_id: string
          started_at: string | null
          status: Database["public"]["Enums"]["run_attempt_status"]
          workspace_path: string
        }
        Insert: {
          attempt_number: number
          created_at?: string
          ended_at?: string | null
          error_class?: string | null
          error_message?: string | null
          id?: string
          issue_id: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["run_attempt_status"]
          workspace_path: string
        }
        Update: {
          attempt_number?: number
          created_at?: string
          ended_at?: string | null
          error_class?: string | null
          error_message?: string | null
          id?: string
          issue_id?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["run_attempt_status"]
          workspace_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_attempts_issue_id_fkey"
            columns: ["issue_id"]
            isOneToOne: false
            referencedRelation: "issues"
            referencedColumns: ["id"]
          },
        ]
      }
      workflows: {
        Row: {
          id: string
          loaded_at: string
          parsed: Json
          prompt_template: string
          source_hash: string
        }
        Insert: {
          id?: string
          loaded_at?: string
          parsed: Json
          prompt_template: string
          source_hash: string
        }
        Update: {
          id?: string
          loaded_at?: string
          parsed?: Json
          prompt_template?: string
          source_hash?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      agent_event_kind:
        | "status"
        | "tool_call"
        | "approval"
        | "token_count"
        | "error"
        | "user_input"
        | "humanized"
      hook_name: "after_create" | "before_run" | "after_run" | "before_remove"
      run_attempt_status:
        | "pending"
        | "running"
        | "success"
        | "failure"
        | "timeout"
        | "cancelled"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      agent_event_kind: [
        "status",
        "tool_call",
        "approval",
        "token_count",
        "error",
        "user_input",
        "humanized",
      ],
      hook_name: ["after_create", "before_run", "after_run", "before_remove"],
      run_attempt_status: [
        "pending",
        "running",
        "success",
        "failure",
        "timeout",
        "cancelled",
      ],
    },
  },
} as const
