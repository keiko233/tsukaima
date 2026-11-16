#!/usr/bin/env bash
# Strict SemVer 2.0.0 validation and precedence. Source this file; do not execute it.
# Build metadata is validated but does not affect version precedence.

SEMVER_PATTERN='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+([0-9A-Za-z-]+)(\.[0-9A-Za-z-]+)*)?$'

semver_valid() {
	[[ "$1" =~ $SEMVER_PATTERN ]]
}

semver_compare() {
	local left="$1"
	local right="$2"
	semver_valid "$left" || return 2
	semver_valid "$right" || return 2

	local LC_ALL=C
	local left_without_build="${left%%+*}"
	local right_without_build="${right%%+*}"
	local left_core="$left_without_build"
	local right_core="$right_without_build"
	local left_prerelease=""
	local right_prerelease=""

	if [[ "$left_without_build" == *-* ]]; then
		left_core="${left_without_build%%-*}"
		left_prerelease="${left_without_build#*-}"
	fi
	if [[ "$right_without_build" == *-* ]]; then
		right_core="${right_without_build%%-*}"
		right_prerelease="${right_without_build#*-}"
	fi

	local IFS=.
	local -a left_core_parts right_core_parts
	read -r -a left_core_parts <<<"$left_core"
	read -r -a right_core_parts <<<"$right_core"

	local index
	for index in 0 1 2; do
		if ((10#${left_core_parts[index]} > 10#${right_core_parts[index]})); then
			printf '1\n'
			return 0
		fi
		if ((10#${left_core_parts[index]} < 10#${right_core_parts[index]})); then
			printf '%s\n' '-1'
			return 0
		fi
	done

	if [[ -z "$left_prerelease" && -z "$right_prerelease" ]]; then
		printf '0\n'
		return 0
	fi
	if [[ -z "$left_prerelease" ]]; then
		printf '1\n'
		return 0
	fi
	if [[ -z "$right_prerelease" ]]; then
		printf '%s\n' '-1'
		return 0
	fi

	local -a left_parts right_parts
	IFS=. read -r -a left_parts <<<"$left_prerelease"
	IFS=. read -r -a right_parts <<<"$right_prerelease"
	local count="${#left_parts[@]}"
	if [[ "${#right_parts[@]}" -lt "$count" ]]; then
		count="${#right_parts[@]}"
	fi
	for ((index = 0; index < count; index += 1)); do
		local left_part="${left_parts[index]}"
		local right_part="${right_parts[index]}"
		if [[ "$left_part" =~ ^[0-9]+$ && "$right_part" =~ ^[0-9]+$ ]]; then
			if ((10#$left_part > 10#$right_part)); then
				printf '1\n'
				return 0
			fi
			if ((10#$left_part < 10#$right_part)); then
				printf '%s\n' '-1'
				return 0
			fi
			continue
		fi
		if [[ "$left_part" =~ ^[0-9]+$ ]]; then
			printf '%s\n' '-1'
			return 0
		fi
		if [[ "$right_part" =~ ^[0-9]+$ ]]; then
			printf '1\n'
			return 0
		fi
		if [[ "$left_part" < "$right_part" ]]; then
			printf '%s\n' '-1'
			return 0
		fi
		if [[ "$left_part" > "$right_part" ]]; then
			printf '1\n'
			return 0
		fi
	done

	if [[ "${#left_parts[@]}" -gt "${#right_parts[@]}" ]]; then
		printf '1\n'
		return 0
	fi
	if [[ "${#left_parts[@]}" -lt "${#right_parts[@]}" ]]; then
		printf '%s\n' '-1'
		return 0
	fi
	printf '0\n'
}
