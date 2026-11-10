# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
{{ $repo := .Info.RepositoryURL }}
{{ range .Versions }}
{{- printf "## [%s] -" .Tag.Name }} {{ datetime "2006-01-02" .Tag.Date }}

{{ range .CommitGroups }}
{{- printf "### %s" .Title }}

{{- range .Commits }}
{{ printf "\n"}}
{{- printf "- %s" .Subject -}}
{{ end }}

{{ end -}}

{{ end -}}

{{ if $repo }}
{{- range .Versions -}}
[{{ .Tag.Name }}]: <{{ $repo }}/releases/tag/{{ .Tag.Name }}>
{{ end -}}
{{ end }}
